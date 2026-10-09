/**
 * Identity routes — design §15.3.
 *
 *   GET  /auth/<provider>            start: set the round-trip cookie, redirect to the provider
 *   GET  /auth/<provider>/callback   finish: verify state, link (store.ts), open a session
 *   POST /auth/signout
 *   GET  /account                    who you are, where your tokens may act, your credentials
 *   POST /account/credentials        mint one — the token is shown once
 *   POST /account/credentials/:id/revoke
 *
 * Mounted by the authoritative host only, and only when the configuration is
 * complete (identityConfigFromEnv). Everything here is `Cache-Control:
 * no-store`. A session is honoured on these routes and nowhere else: no
 * authoring or operator route reads the cookie (§15.3), which is what keeps a
 * cross-site request from becoming a registration or a publication.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { escape, page, enableAccountNav } from '../part-three/routes.ts';
import { SCOPES, type Scope } from '../part-two/routes.ts';
import { mint, revoke } from '../credentials/store.ts';
import {
  PROVIDERS, type ProviderName, IdentityRefused,
  linkOrCreate, createSession, findSession, touchSession, revokeSession, signSessionId, verifySessionCookie, accountView,
  administeredOrgs, type AccountView, type AdministeredOrg, type RoleSummary,
} from './store.ts';
import { addMember, grantRole, parseRoles, removeMember, revokeRole, RoleError, ROLES, administers, type RoleActor } from '../part-one/roles.ts';
import { GoogleProvider, GitHubProvider, ProviderError, type Provider, type FetchLike } from './providers.ts';

export type IdentityConfig = {
  /** The origin the provider callbacks are registered against: https://cp.cnscp.io, or http://localhost:8082. */
  publicOrigin: string;
  sessionSecret: string;
  providers: Provider[];
};

export type IdentityDeps = { pool: pg.Pool; config: IdentityConfig; now?: () => Date };

const ENV_KEYS = [
  'CP_OAUTH_GOOGLE_CLIENT_ID', 'CP_OAUTH_GOOGLE_CLIENT_SECRET',
  'CP_OAUTH_GITHUB_CLIENT_ID', 'CP_OAUTH_GITHUB_CLIENT_SECRET',
  'CP_SESSION_SECRET', 'CP_PUBLIC_ORIGIN',
] as const;

/**
 * All six variables → a configuration. None → null, and the host runs without
 * sign-in exactly as before. Some → an error, because a half-configured
 * front door is a misconfiguration, not a choice.
 */
export function identityConfigFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): IdentityConfig | null {
  const present = ENV_KEYS.filter((k) => env[k]);
  if (present.length === 0) return null;
  if (present.length !== ENV_KEYS.length) {
    const missing = ENV_KEYS.filter((k) => !env[k]);
    throw new Error(`identity: ${missing.join(', ')} missing; set all of ${ENV_KEYS.join(', ')} or none`);
  }
  if (env['CP_SESSION_SECRET']!.length < 32) throw new Error('identity: CP_SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)');
  const origin = new URL(env['CP_PUBLIC_ORIGIN']!).origin;
  const fetchOpt = fetchImpl ? { fetch: fetchImpl } : {};
  return {
    publicOrigin: origin,
    sessionSecret: env['CP_SESSION_SECRET']!,
    providers: [
      new GoogleProvider({ clientId: env['CP_OAUTH_GOOGLE_CLIENT_ID']!, clientSecret: env['CP_OAUTH_GOOGLE_CLIENT_SECRET']!, ...fetchOpt }),
      new GitHubProvider({ clientId: env['CP_OAUTH_GITHUB_CLIENT_ID']!, clientSecret: env['CP_OAUTH_GITHUB_CLIENT_SECRET']!, ...fetchOpt }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Cookies — parsed and set by hand; two of them, both HttpOnly.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'cp_session';
const AUTH_COOKIE = 'cp_auth';
const AUTH_COOKIE_TTL_S = 10 * 60;

function cookies(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setCookie(reply: FastifyReply, name: string, value: string, opts: { path: string; maxAge: number; secure: boolean }): void {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(opts.secure ? ['Secure'] : []),
  ];
  const existing = reply.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  reply.header('set-cookie', [...list, attrs.join('; ')]);
}

/** The authorization round-trip state, signed so the callback can trust it. */
type AuthRoundTrip = { provider: ProviderName; state: string; codeVerifier: string; nonce: string };

function sign(payload: string, secret: string, purpose: string): string {
  return createHmac('sha256', `${secret}:${purpose}`).update(payload).digest('base64url');
}

function sealed(value: AuthRoundTrip, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret, 'auth')}`;
}

function unseal(cookie: string | undefined, secret: string): AuthRoundTrip | null {
  if (!cookie) return null;
  const dot = cookie.indexOf('.');
  if (dot <= 0) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = sign(payload, secret, 'auth');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthRoundTrip;
  } catch {
    return null;
  }
}

/** Per-session form token: derived, so nothing to store. */
function csrfFor(sessionId: string, secret: string): string {
  return sign(sessionId, secret, 'csrf');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The author scopes a person may put on their own token. `operator` is never among them (§15.3). */
export const ACCOUNT_SCOPES: readonly Scope[] = SCOPES.filter((s) => s !== 'operator');

export async function registerIdentityRoutes(app: FastifyInstance, deps: IdentityDeps): Promise<void> {
  const { pool, config } = deps;
  const now = deps.now ?? (() => new Date());
  const secure = config.publicOrigin.startsWith('https:');
  const providers = new Map(config.providers.map((p) => [p.name, p]));
  enableAccountNav();

  // These routes are opened by a person in a browser, so an unexpected
  // failure should look like the rest of the site, not like Fastify's JSON.
  // The handler is scoped to this plugin: the authoring API keeps its
  // structured JSON refusals, which machine authors parse (§15.1).
  await app.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => {
      request.log.error({ err: error }, 'identity: unhandled failure');
      const code = (error as { statusCode?: unknown }).statusCode;
      const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
      return noStore(reply)
        .code(status)
        .type('text/html; charset=utf-8')
        .send(page('Something went wrong', `<h1>Something went wrong</h1>
<p>The Registry could not finish that request. Nothing was changed: each of these acts is one transaction, and a failure rolls it back.</p>
<p>Try again, and if it keeps happening write to <a href="mailto:info@cnscp.io">info@cnscp.io</a> saying what you were doing.</p>
<p><a class="btn btn-primary" href="/account">Back to your account</a></p>`, 'account'));
    });

    // Forms post as application/x-www-form-urlencoded; nothing else in the
    // Registry does, so the parser lives here.
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded')) {
      scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        const params = new URLSearchParams(body as string);
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of params) {
          const prev = out[k];
          out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
        }
        done(null, out);
      });
    }

    const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');
    const redirectUri = (provider: ProviderName) => `${config.publicOrigin}/auth/${provider}/callback`;

    const html = (reply: FastifyReply, status: number, title: string, body: string, active: 'account' | null = 'account') =>
      noStore(reply).code(status).type('text/html; charset=utf-8').send(page(title, body, active));

    /** The signed-in user for this request, or null. Touches the session. */
    async function currentSession(request: FastifyRequest): Promise<{ sessionId: string; rowId: string; userId: string } | null> {
      const id = verifySessionCookie(cookies(request)[SESSION_COOKIE], config.sessionSecret);
      if (!id) return null;
      const session = await findSession(pool, id, now());
      if (!session) return null;
      await touchSession(pool, session.rowId, now());
      return { sessionId: id, rowId: session.rowId, userId: session.userId };
    }

    function providerOr404(reply: FastifyReply, name: string): Provider | null {
      const p = (PROVIDERS as readonly string[]).includes(name) ? providers.get(name as ProviderName) : undefined;
      if (!p) {
        html(reply, 404, 'No such sign-in', `<h1>No such sign-in</h1><p>The Registry signs people in with ${[...providers.keys()].join(' and ')}.</p>`, null);
        return null;
      }
      return p;
    }

    // --- sign in -------------------------------------------------------------

    scope.get<{ Params: { provider: string } }>('/auth/:provider', async (request, reply) => {
      const provider = providerOr404(reply, request.params.provider);
      if (!provider) return;
      const started = provider.start(redirectUri(provider.name));
      setCookie(reply, AUTH_COOKIE, sealed({ provider: provider.name, state: started.state, codeVerifier: started.codeVerifier, nonce: started.nonce }, config.sessionSecret), {
        path: '/auth', maxAge: AUTH_COOKIE_TTL_S, secure,
      });
      return noStore(reply).redirect(started.url, 302);
    });

    scope.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
      '/auth/:provider/callback',
      async (request, reply) => {
        const provider = providerOr404(reply, request.params.provider);
        if (!provider) return;
        // Clear the round-trip cookie whatever happens next.
        setCookie(reply, AUTH_COOKIE, '', { path: '/auth', maxAge: 0, secure });

        if (request.query.error) {
          return html(reply, 400, 'Sign-in declined', `<h1>Sign-in declined</h1><p>${escape(provider.name)} reported <code>${escape(request.query.error)}</code>${
            request.query.error_description ? `: ${escape(request.query.error_description)}` : ''}.</p><p><a href="/account">Try again</a></p>`);
        }
        const trip = unseal(cookies(request)[AUTH_COOKIE], config.sessionSecret);
        if (!trip || trip.provider !== provider.name || !request.query.state || trip.state !== request.query.state || !request.query.code) {
          return html(reply, 400, 'Sign-in did not complete', `<h1>Sign-in did not complete</h1><p>The response from ${escape(provider.name)} did not match the request this browser started (the state is missing, stale, or from a different attempt). Nothing was recorded.</p><p><a href="/account">Start again</a></p>`);
        }

        let asserted;
        try {
          asserted = await provider.finish(request.query.code, redirectUri(provider.name), { codeVerifier: trip.codeVerifier, nonce: trip.nonce });
        } catch (e) {
          request.log.warn({ err: e }, 'identity: provider exchange failed');
          const msg = e instanceof ProviderError ? e.message : 'the provider could not be reached';
          return html(reply, 502, 'Sign-in failed', `<h1>Sign-in failed</h1><p>${escape(msg)}. Nothing was recorded.</p><p><a href="/account">Try again</a></p>`);
        }

        const client = await pool.connect();
        let userId: string;
        try {
          await client.query('BEGIN');
          const linked = await linkOrCreate(client, asserted);
          await client.query('COMMIT');
          userId = linked.userId;
          request.log.info({ provider: provider.name, outcome: linked.outcome, user: userId }, 'identity: signed in');
        } catch (e) {
          await client.query('ROLLBACK');
          if (e instanceof IdentityRefused) {
            return html(reply, 403, 'Sign-in refused', `<h1>Sign-in refused</h1><p>${escape(e.message)}</p><p>Nothing was recorded.</p>`);
          }
          throw e;
        } finally {
          client.release();
        }

        const session = await createSession(pool, userId, now());
        setCookie(reply, SESSION_COOKIE, signSessionId(session.id, config.sessionSecret), {
          path: '/', maxAge: Math.floor((session.expiresAt.getTime() - now().getTime()) / 1000), secure,
        });
        return noStore(reply).redirect('/account', 302);
      },
    );

    scope.post('/auth/signout', async (request, reply) => {
      const current = await currentSession(request);
      if (current) await revokeSession(pool, current.rowId);
      setCookie(reply, SESSION_COOKIE, '', { path: '/', maxAge: 0, secure });
      return noStore(reply).redirect('/', 302);
    });

    // --- the account page ----------------------------------------------------

    // --- /account, as tabs (9 October 2026) ------------------------------------
    //
    // Each tab is its own address, so it can be bookmarked and an act returns
    // the person to the tab they acted on. Plain links styled as tabs: nothing
    // on the Registry's pages runs script.

    async function signedIn(request: FastifyRequest, reply: FastifyReply) {
      const current = await currentSession(request);
      if (!current) {
        html(reply, 200, 'Sign in', renderSignIn([...providers.keys()]));
        return null;
      }
      const view = await accountView(pool, current.userId);
      if (!view) {
        html(reply, 200, 'Sign in', renderSignIn([...providers.keys()]));
        return null;
      }
      const admin = await administeredOrgs(pool, current.userId);
      return { current, view, admin, csrf: csrfFor(current.sessionId, config.sessionSecret) };
    }

    scope.get('/account', async (request, reply) => {
      const s = await signedIn(request, reply);
      if (!s) return;
      return html(reply, 200, 'Account', renderTabs('profile', s.admin.length > 0) + renderProfile(s.view, s.csrf));
    });

    scope.get('/account/memberships', async (request, reply) => {
      const s = await signedIn(request, reply);
      if (!s) return;
      return html(reply, 200, 'Memberships', renderTabs('memberships', s.admin.length > 0) + renderMemberships(s.view));
    });

    scope.get('/account/credentials', async (request, reply) => {
      const s = await signedIn(request, reply);
      if (!s) return;
      return html(reply, 200, 'Credentials', renderTabs('credentials', s.admin.length > 0) + renderCredentials(s.view, s.csrf));
    });

    scope.get('/account/orgs', async (request, reply) => {
      const s = await signedIn(request, reply);
      if (!s) return;
      // One organization to administer: open straight onto it.
      if (s.admin.length === 1) return noStore(reply).redirect(`/account/orgs/${s.admin[0]!.orgId}`, 302);
      return html(reply, 200, 'Organizations', renderTabs('orgs', s.admin.length > 0) + renderOrgPicker(s.admin, null) + (s.admin.length === 0
        ? `<p class="note">You administer no organization. An organization's admins add members and grant roles here.</p>`
        : `<p class="note">Choose an organization.</p>`));
    });

    scope.get<{ Params: { org: string } }>('/account/orgs/:org', async (request, reply) => {
      const s = await signedIn(request, reply);
      if (!s) return;
      const org = s.admin.find((o) => o.orgId === request.params.org);
      if (!org) {
        return html(reply, 404, 'Not yours to administer', renderTabs('orgs', s.admin.length > 0) +
          `<h1>Not yours to administer</h1><p>You are not an admin of that organization. <a href="/account/orgs">Back</a></p>`);
      }
      return html(reply, 200, org.orgName, renderTabs('orgs', true) + renderOrgPicker(s.admin, org.orgId) + renderOrg(org, s.csrf));
    });

    type MintForm = { csrf?: string; label?: string; kind?: string; scope?: string | string[] };

    scope.post<{ Body: MintForm }>('/account/credentials', async (request, reply) => {
      const current = await currentSession(request);
      if (!current) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));
      const body = request.body ?? {};
      if (body.csrf !== csrfFor(current.sessionId, config.sessionSecret)) {
        return html(reply, 403, 'Refused', `<h1>Refused</h1><p>This form was not issued to this session. <a href="/account/credentials">Back</a></p>`);
      }
      const view = await accountView(pool, current.userId);
      if (!view) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));

      const kind = body.kind === 'agent' || body.kind === 'service' ? body.kind : 'human';
      const requested = (Array.isArray(body.scope) ? body.scope : body.scope ? [body.scope] : []).map(String);
      const unknown = requested.filter((s) => !(ACCOUNT_SCOPES as readonly string[]).includes(s));
      if (unknown.length > 0) {
        return html(reply, 400, 'Refused', `<h1>Refused</h1><p>Scope${unknown.length > 1 ? 's' : ''} <code>${unknown.map(escape).join('</code>, <code>')}</code> cannot be minted here (§15.3). <a href="/account/credentials">Back</a></p>`);
      }
      const scopes = ACCOUNT_SCOPES.filter((s) => requested.includes(s));
      const label = String(body.label ?? '').trim();
      if (scopes.length === 0 || !label) {
        return html(reply, 400, 'Refused', `<h1>Refused</h1><p>A credential needs a label and at least one scope. <a href="/account/credentials">Back</a></p>`);
      }

      const client = await pool.connect();
      let minted: { token: string; id: string };
      try {
        await client.query('BEGIN');
        minted = await mint(client, {
          userId: current.userId, kind, ...(kind === 'human' ? {} : { principal: view.user.email }), scopes, label,
          by: view.user.email, byKind: 'human',
        });
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return html(reply, 201, 'Credential minted', renderMinted(minted.token, label, kind, scopes));
    });

    scope.post<{ Params: { id: string }; Body: { csrf?: string } }>('/account/credentials/:id/revoke', async (request, reply) => {
      const current = await currentSession(request);
      if (!current) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));
      if ((request.body ?? {}).csrf !== csrfFor(current.sessionId, config.sessionSecret)) {
        return html(reply, 403, 'Refused', `<h1>Refused</h1><p>This form was not issued to this session. <a href="/account/credentials">Back</a></p>`);
      }
      const view = await accountView(pool, current.userId);
      const own = view?.credentials.find((c) => c.id === request.params.id);
      if (!view || !own) {
        return html(reply, 404, 'No such credential', `<h1>No such credential</h1><p>Only your own credentials appear here. <a href="/account/credentials">Back</a></p>`);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await revoke(client, own.id, view.user.email, `Revoked by its owner on /account: ${own.label}`, 'human');
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return noStore(reply).redirect('/account/credentials', 302);
    });

    // --- organizations an admin administers (§6.2) ---------------------------
    //
    // Every act here runs as the signed-in PERSON, never a token: granting
    // authority is something people do. Each one is checked by roles.ts —
    // admins act only within what they administer — and audited there.

    type OrgForm = { csrf?: string; email?: string; user?: string; branch?: string; name_only?: string; role?: string | string[] };

    async function asAdmin(
      request: FastifyRequest<{ Params: { org: string }; Body: OrgForm }>,
      reply: FastifyReply,
      act: (db: pg.PoolClient, actor: RoleActor, body: OrgForm) => Promise<void>,
    ): Promise<unknown> {
      const current = await currentSession(request);
      if (!current) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));
      const body = request.body ?? {};
      if (body.csrf !== csrfFor(current.sessionId, config.sessionSecret)) {
        return html(reply, 403, 'Refused', `<h1>Refused</h1><p>This form was not issued to this session. <a href="/account/credentials">Back</a></p>`);
      }
      const view = await accountView(pool, current.userId);
      if (!view) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));
      const actor: RoleActor = { kind: 'human', userId: current.userId, email: view.user.email };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await act(client, actor, body);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        if (e instanceof RoleError) {
          const status = e.code === 'role.not-admin' ? 403 : 400;
          return html(reply, status, 'Refused', `<h1>Refused</h1><p>${escape(e.message)}</p><p><a href="/account/orgs/${escape(request.params.org)}">Back</a></p>`);
        }
        throw e;
      } finally {
        client.release();
      }
      return noStore(reply).redirect(`/account/orgs/${request.params.org}`, 303);
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    async function userByEmail(db: pg.PoolClient, email: string): Promise<string> {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM app_user WHERE lower(email) = lower($1)`, [email.trim()]);
      if (!rows[0]) {
        throw new RoleError('role.no-such-person', `Nobody with the email ${email.trim()} has signed in to the Registry yet. Ask them to sign in once at /account, then add them.`);
      }
      return rows[0].id;
    }
    function orgParam(org: string): string {
      if (!UUID_RE.test(org)) throw new RoleError('role.bad-request', 'Not an organization.');
      return org;
    }
    function userParam(user: string | undefined): string {
      if (!user || !UUID_RE.test(user)) throw new RoleError('role.bad-request', 'Choose a member.');
      return user;
    }

    scope.post<{ Params: { org: string }; Body: OrgForm }>('/account/orgs/:org/members', (request, reply) =>
      asAdmin(request, reply, async (db, actor, body) => {
        const org = orgParam(request.params.org);
        await addMember(db, { orgId: org, userId: await userByEmail(db, String(body.email ?? '')), actor });
      }));

    scope.post<{ Params: { org: string }; Body: OrgForm }>('/account/orgs/:org/members/remove', (request, reply) =>
      asAdmin(request, reply, async (db, actor, body) => {
        await removeMember(db, { orgId: orgParam(request.params.org), userId: userParam(body.user), actor });
      }));

    scope.post<{ Params: { org: string }; Body: OrgForm }>('/account/orgs/:org/roles', (request, reply) =>
      asAdmin(request, reply, async (db, actor, body) => {
        const requested = Array.isArray(body.role) ? body.role : body.role ? [body.role] : [];
        await grantRole(db, {
          orgId: orgParam(request.params.org),
          userId: userParam(body.user),
          branch: String(body.branch ?? '').trim(),
          reach: body.name_only ? 'name' : 'branch',
          roles: parseRoles(requested.map(String)),
          actor,
        });
      }));

    scope.post<{ Params: { org: string; id: string }; Body: OrgForm }>('/account/orgs/:org/roles/:id/revoke', (request, reply) =>
      asAdmin(request as never, reply, async (db, actor) => {
        if (!UUID_RE.test(request.params.id)) throw new RoleError('role.bad-request', 'Not a role.');
        await revokeRole(db, { orgId: orgParam(request.params.org), roleId: request.params.id, actor });
      }));
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSignIn(providers: ProviderName[]): string {
  const label: Record<ProviderName, string> = { google: 'Sign in with Google', github: 'Sign in with GitHub' };
  return `<h1>Sign in</h1>
<p class="section-intro">An account on the Registry is your identity; where you may act is decided by the organizations that hold Prefixes and count you as a member. The Registry keeps no password — it asks Google or GitHub who you are, and links you by verified email.</p>
<p>${providers.map((p) => `<a class="btn btn-primary" href="/auth/${p}" rel="nofollow">${label[p]}</a>`).join(' ')}</p>
<p class="note">Signing in creates an account if you do not have one. Reading the Registry never needs one.</p>`;
}

function date(d: Date | null): string {
  return d ? escape(d.toISOString().slice(0, 16).replace('T', ' ')) : '<em>never</em>';
}

function roleLine(r: RoleSummary): string {
  const where = r.branch === '*' ? 'everything the organization holds (<code>*</code>)' : r.reach === 'name' ? `the name <code>${escape(r.branch)}</code>` : `<code>${escape(r.branch)}</code> and beneath`;
  return `${r.roles.map((x) => `<strong>${escape(x)}</strong>`).join(' + ')} on ${where}`;
}

const INPUT = 'font:inherit;padding:8px 12px;border:1px solid var(--border);border-radius:8px';

function renderOrg(org: AdministeredOrg, csrf: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const whole = org.mine.some((r) => r.branch === '*');
  const base = `/account/orgs/${escape(org.orgId)}`;
  const rows = org.members.map((m) => {
    const roles = m.roles.length === 0 ? '<em>no roles</em>' : m.roles.map((r) => {
      const mayRevoke = org.mine.some((a) => administers(a, { branch: r.branch, reach: r.reach }));
      return `${roleLine(r)}${mayRevoke ? ` <form method="post" action="${base}/roles/${escape(r.id)}/revoke" style="display:inline">${hidden}<button class="btn" type="submit" style="padding:2px 10px;font-size:.85rem">Revoke</button></form>` : ''}`;
    }).join('<br>');
    const remove = whole ? `<form method="post" action="${base}/members/remove" onsubmit="return confirm('Remove ${escape(m.email).replace(/'/g, '&#39;')} and every role they hold here?')">${hidden}<input type="hidden" name="user" value="${escape(m.userId)}"><button class="btn" type="submit" style="padding:2px 10px;font-size:.85rem">Remove</button></form>` : '';
    return `<tr><td>${escape(m.email)}${m.displayName ? `<br><span class="note">${escape(m.displayName)}</span>` : ''}</td><td>${roles}</td><td>${remove}</td></tr>`;
  }).join('');
  const branches = [...(whole ? ['*', ...org.prefixes] : []), ...org.mine.filter((r) => r.branch !== '*').map((r) => r.branch)];
  const roleBoxes = ROLES.map((r) => `<label style="margin-right:14px"><input type="checkbox" name="role" value="${r}"${r !== 'admin' ? ' checked' : ''}> <code>${r}</code></label>`).join('');
  return `<h2 id="org-${escape(org.orgId)}">${escape(org.orgName)}</h2>
<p class="note">You administer ${org.mine.map(roleLine).join('; ')}.</p>
<div class="card"><table class="account-roles"><thead><tr><th>Member</th><th>Roles</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<form method="post" action="${base}/roles" class="callout">${hidden}
  <p><strong>Grant roles</strong></p>
  <p><label>Member<br><select name="user" style="${INPUT}">${org.members.map((m) => `<option value="${escape(m.userId)}">${escape(m.email)}</option>`).join('')}</select></label></p>
  <p><label>Branch<br><input name="branch" required list="branches-${escape(org.orgId)}" placeholder="e.g. ${escape(org.prefixes[0] ?? 'acme')}.xyz" style="${INPUT};width:min(100%,360px)"></label>
    <datalist id="branches-${escape(org.orgId)}">${branches.map((b) => `<option value="${escape(b)}">`).join('')}</datalist>
    <label style="margin-left:12px"><input type="checkbox" name="name_only" value="1"> this name only</label></p>
  <p>Roles<br>${roleBoxes}</p>
  <p class="note">A branch covers that name and everything beneath it; <code>*</code> covers everything the organization holds, now and later. <code>register</code> claims and releases names; <code>publish</code> publishes, deprecates and changes Owner or Website; <code>admin</code> lets them grant within the branch. Granting again on the same branch replaces what they had there.</p>
  <p><button class="btn btn-primary" type="submit">Grant</button></p>
</form>
<form method="post" action="${base}/members" class="callout">${hidden}
  <p><strong>Add a member</strong> &mdash; anyone who has signed in to the Registry once. Membership alone lets them do nothing until you grant a role.</p>
  <p><input name="email" type="email" required placeholder="their sign-in email" style="${INPUT};width:min(100%,360px)"> <button class="btn btn-primary" type="submit">Add</button></p>
</form>`;
}

type Tab = 'profile' | 'memberships' | 'credentials' | 'orgs';

const TAB_STYLE = `<style>
  .tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border);margin:0 0 28px;padding:0;list-style:none}
  .tabs li{margin:0}
  .tabs a{display:block;padding:9px 16px;border:1px solid transparent;border-bottom:0;border-radius:10px 10px 0 0;
    color:var(--body);font-weight:550;margin-bottom:-1px}
  .tabs a:hover{background:var(--panel);text-decoration:none}
  .tabs a.active{border-color:var(--border);background:#fff;color:var(--blue);font-weight:650}
  .org-pills{margin:-8px 0 20px}
  .account-roles td:nth-child(2){min-width:22em}
</style>`;

function renderTabs(active: Tab, admin: boolean): string {
  const tabs: [Tab, string, string][] = [
    ['profile', 'Profile', '/account'],
    ['memberships', 'Memberships', '/account/memberships'],
    ['credentials', 'Credentials', '/account/credentials'],
    ...(admin ? [['orgs', 'Organizations', '/account/orgs'] as [Tab, string, string]] : []),
  ];
  return `${TAB_STYLE}<h1>Account</h1>
<ul class="tabs">${tabs.map(([id, label, href]) => `<li><a${id === active ? ' class="active"' : ''} href="${href}">${label}</a></li>`).join('')}</ul>`;
}

function renderProfile(view: AccountView, csrf: string): string {
  const identities = view.identities.map((i) => `<tr><td>${escape(i.provider)}</td><td>${escape(i.email)}</td><td>${escape(i.displayName ?? '')}</td><td>${date(i.firstSeen)}</td><td>${date(i.lastSeen)}</td></tr>`).join('');
  return `<p>${escape(view.user.displayName ?? '')} &middot; <code>${escape(view.user.email)}</code>
<form method="post" action="/auth/signout" style="display:inline;margin-left:12px"><input type="hidden" name="csrf" value="${escape(csrf)}"><button class="btn" type="submit">Sign out</button></form></p>

<h2>Identities</h2>
<p class="section-intro">The sign-ins linked to this account. The Registry keeps no password; it asks Google or GitHub who you are.</p>
<div class="card"><table><thead><tr><th>Provider</th><th>Email</th><th>Name</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>${identities}</tbody></table></div>`;
}

function renderMemberships(view: AccountView): string {
  const memberships = view.memberships.length === 0
    ? `<p class="note">No memberships yet. A token you mint can do nothing until an admin of the organization that holds the Prefix you author under adds you and grants you a role — ask them, giving your email (${escape(view.user.email)}).</p>`
    : `<div class="card"><table class="account-roles"><thead><tr><th>Organization</th><th>Your roles</th><th>Prefixes it holds</th></tr></thead><tbody>${view.memberships.map((m) =>
        `<tr><td>${escape(m.orgName)}</td><td>${m.roles.length ? m.roles.map(roleLine).join('<br>') : '<em>none yet — ask an admin of the organization</em>'}</td><td>${m.prefixes.length ? m.prefixes.map((p) => `<code>cp:${escape(p)}</code>`).join(' ') : '<em>none held</em>'}</td></tr>`).join('')}</tbody></table></div>`;
  return `<p class="section-intro">Where your tokens may act. An act needs all three: membership of the organization, a role covering the name (granted by its admins), and a token carrying the matching scope.</p>
${memberships}`;
}

function renderCredentials(view: AccountView, csrf: string): string {
  const credentials = view.credentials.length === 0
    ? `<p class="note">No credentials yet.</p>`
    : `<div class="card"><table><thead><tr><th>Label</th><th>Kind</th><th>Scopes</th><th>Minted</th><th>Last used</th><th></th></tr></thead><tbody>${view.credentials.map((c) =>
        `<tr${c.revokedAt ? ' style="opacity:.55"' : ''}><td><strong>${escape(c.label)}</strong></td><td>${escape(c.kind)}${c.principal && c.kind !== 'human' ? ` <span class="note">for ${escape(c.principal)}</span>` : ''}</td><td>${c.scopes.map((s) => `<code>${escape(s)}</code>`).join(' ')}</td><td>${date(c.createdAt)}</td><td>${date(c.lastUsedAt)}</td><td>${
          c.revokedAt ? `<em>revoked ${date(c.revokedAt)}</em>` : `<form method="post" action="/account/credentials/${escape(c.id)}/revoke" onsubmit="return confirm('Revoke ${escape(c.label).replace(/'/g, '&#39;')}? The token stops working immediately.')"><input type="hidden" name="csrf" value="${escape(csrf)}"><button class="btn" type="submit">Revoke</button></form>`}</td></tr>`).join('')}</tbody></table></div>`;
  const scopeBoxes = ACCOUNT_SCOPES.map((s) => `<label style="margin-right:14px"><input type="checkbox" name="scope" value="${s}"${s === 'register' || s === 'steward' || s === 'release' ? ' checked' : ''}> <code>${s}</code></label>`).join('');
  return `${credentials}

<h2>Mint a credential</h2>
<form method="post" action="/account/credentials" class="callout">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <p><label>Label<br><input name="label" required maxlength="120" placeholder="e.g. Claude Desktop, or my laptop" style="${INPUT};width:min(100%,420px)"></label></p>
  <p><label>Kind<br><select name="kind" style="${INPUT}">
    <option value="human">human — me, at a keyboard</option>
    <option value="agent">agent — an assistant acting for me</option>
    <option value="service">service — a job or pipeline acting for me</option>
  </select></label></p>
  <p>Scopes<br>${scopeBoxes}</p>
  <p class="note"><code>register</code> also rehearses a publication (dry run). <code>publish</code> is the one irreversible act; an assistant normally does without it. <code>operator</code> cannot be minted here. A scope says what kind of act the token may do; where it may act is decided by your roles (Memberships).</p>
  <p><button class="btn btn-primary" type="submit">Mint</button></p>
</form>`;
}

function renderOrgPicker(orgs: AdministeredOrg[], current: string | null): string {
  if (orgs.length <= 1) return '';
  return `<p class="versions org-pills">${orgs.map((o) => o.orgId === current
    ? `<span class="pill current">${escape(o.orgName)}</span>`
    : `<a class="pill" href="/account/orgs/${escape(o.orgId)}">${escape(o.orgName)}</a>`).join(' ')}</p>`;
}

function renderMinted(token: string, label: string, kind: string, scopes: readonly string[]): string {
  return `<h1>Credential minted</h1>
<p>${escape(label)} &middot; ${escape(kind)} &middot; ${scopes.map((s) => `<code>${escape(s)}</code>`).join(' ')}</p>
<div class="callout"><p><strong>This is the only time the token is shown.</strong> Copy it now; the Registry keeps only its hash.</p>
<p><code style="font-size:1.05em;user-select:all">${escape(token)}</code></p></div>
<p>Present it as <code>Authorization: Bearer &lt;token&gt;</code>, or as <code>CP_REGISTRY_TOKEN</code> in an MCP configuration. If it is ever exposed, revoke it on the <a href="/account/credentials">Credentials tab</a>; a revoked token stops working immediately.</p>`;
}
