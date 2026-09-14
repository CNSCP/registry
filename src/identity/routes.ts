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
  type AccountView,
} from './store.ts';
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

    scope.get('/account', async (request, reply) => {
      const current = await currentSession(request);
      if (!current) return html(reply, 200, 'Sign in', renderSignIn([...providers.keys()]));
      const view = await accountView(pool, current.userId);
      if (!view) return html(reply, 200, 'Sign in', renderSignIn([...providers.keys()]));
      return html(reply, 200, 'Account', renderAccount(view, csrfFor(current.sessionId, config.sessionSecret)));
    });

    type MintForm = { csrf?: string; label?: string; kind?: string; scope?: string | string[] };

    scope.post<{ Body: MintForm }>('/account/credentials', async (request, reply) => {
      const current = await currentSession(request);
      if (!current) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));
      const body = request.body ?? {};
      if (body.csrf !== csrfFor(current.sessionId, config.sessionSecret)) {
        return html(reply, 403, 'Refused', `<h1>Refused</h1><p>This form was not issued to this session. <a href="/account">Back</a></p>`);
      }
      const view = await accountView(pool, current.userId);
      if (!view) return html(reply, 401, 'Sign in', renderSignIn([...providers.keys()]));

      const kind = body.kind === 'agent' || body.kind === 'service' ? body.kind : 'human';
      const requested = (Array.isArray(body.scope) ? body.scope : body.scope ? [body.scope] : []).map(String);
      const unknown = requested.filter((s) => !(ACCOUNT_SCOPES as readonly string[]).includes(s));
      if (unknown.length > 0) {
        return html(reply, 400, 'Refused', `<h1>Refused</h1><p>Scope${unknown.length > 1 ? 's' : ''} <code>${unknown.map(escape).join('</code>, <code>')}</code> cannot be minted here (§15.3). <a href="/account">Back</a></p>`);
      }
      const scopes = ACCOUNT_SCOPES.filter((s) => requested.includes(s));
      const label = String(body.label ?? '').trim();
      if (scopes.length === 0 || !label) {
        return html(reply, 400, 'Refused', `<h1>Refused</h1><p>A credential needs a label and at least one scope. <a href="/account">Back</a></p>`);
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
        return html(reply, 403, 'Refused', `<h1>Refused</h1><p>This form was not issued to this session. <a href="/account">Back</a></p>`);
      }
      const view = await accountView(pool, current.userId);
      const own = view?.credentials.find((c) => c.id === request.params.id);
      if (!view || !own) {
        return html(reply, 404, 'No such credential', `<h1>No such credential</h1><p>Only your own credentials appear here. <a href="/account">Back</a></p>`);
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
      return noStore(reply).redirect('/account', 302);
    });
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

function renderAccount(view: AccountView, csrf: string): string {
  const identities = view.identities.map((i) => `<tr><td>${escape(i.provider)}</td><td>${escape(i.email)}</td><td>${escape(i.displayName ?? '')}</td><td>${date(i.firstSeen)}</td><td>${date(i.lastSeen)}</td></tr>`).join('');
  const memberships = view.memberships.length === 0
    ? `<p class="note">No memberships yet. A token you mint can do nothing until an operator attaches you to the organization that holds the Prefix you author under — ask them, giving the email above.</p>`
    : `<div class="card"><table><thead><tr><th>Organization</th><th>Role</th><th>Prefixes</th></tr></thead><tbody>${view.memberships.map((m) =>
        `<tr><td>${escape(m.orgName)}</td><td>${escape(m.role)}</td><td>${m.prefixes.length ? m.prefixes.map((p) => `<code>cp:${escape(p)}</code>`).join(' ') : '<em>none held</em>'}</td></tr>`).join('')}</tbody></table></div>`;
  const credentials = view.credentials.length === 0
    ? `<p class="note">No credentials yet.</p>`
    : `<div class="card"><table><thead><tr><th>Label</th><th>Kind</th><th>Scopes</th><th>Minted</th><th>Last used</th><th></th></tr></thead><tbody>${view.credentials.map((c) =>
        `<tr${c.revokedAt ? ' style="opacity:.55"' : ''}><td><strong>${escape(c.label)}</strong></td><td>${escape(c.kind)}${c.principal && c.kind !== 'human' ? ` <span class="note">for ${escape(c.principal)}</span>` : ''}</td><td>${c.scopes.map((s) => `<code>${escape(s)}</code>`).join(' ')}</td><td>${date(c.createdAt)}</td><td>${date(c.lastUsedAt)}</td><td>${
          c.revokedAt ? `<em>revoked ${date(c.revokedAt)}</em>` : `<form method="post" action="/account/credentials/${escape(c.id)}/revoke" onsubmit="return confirm('Revoke ${escape(c.label).replace(/'/g, '&#39;')}? The token stops working immediately.')"><input type="hidden" name="csrf" value="${escape(csrf)}"><button class="btn" type="submit">Revoke</button></form>`}</td></tr>`).join('')}</tbody></table></div>`;
  const scopeBoxes = ACCOUNT_SCOPES.map((s) => `<label style="margin-right:14px"><input type="checkbox" name="scope" value="${s}"${s === 'register' || s === 'steward' || s === 'release' ? ' checked' : ''}> <code>${s}</code></label>`).join('');
  return `<h1>Account</h1>
<p>${escape(view.user.displayName ?? '')} &middot; <code>${escape(view.user.email)}</code>
<form method="post" action="/auth/signout" style="display:inline;margin-left:12px"><input type="hidden" name="csrf" value="${escape(csrf)}"><button class="btn" type="submit">Sign out</button></form></p>

<h2>Identities</h2>
<div class="card"><table><thead><tr><th>Provider</th><th>Email</th><th>Name</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>${identities}</tbody></table></div>

<h2>Memberships</h2>
<p class="section-intro">Where your tokens may act. A token carries scopes — what kind of act — but reach comes from membership: an organization that holds a Prefix and counts you as a member.</p>
${memberships}

<h2>Credentials</h2>
${credentials}

<h3>Mint a credential</h3>
<form method="post" action="/account/credentials" class="callout">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <p><label>Label<br><input name="label" required maxlength="120" placeholder="e.g. Claude Desktop, or my laptop" style="font:inherit;padding:8px 12px;border:1px solid var(--border);border-radius:8px;width:min(100%,420px)"></label></p>
  <p><label>Kind<br><select name="kind" style="font:inherit;padding:8px 12px;border:1px solid var(--border);border-radius:8px">
    <option value="human">human — me, at a keyboard</option>
    <option value="agent">agent — an assistant acting for me</option>
    <option value="service">service — a job or pipeline acting for me</option>
  </select></label></p>
  <p>Scopes<br>${scopeBoxes}</p>
  <p class="note"><code>register</code> also rehearses a publication (dry run). <code>publish</code> is the one irreversible act; an assistant normally does without it. <code>operator</code> cannot be minted here.</p>
  <p><button class="btn btn-primary" type="submit">Mint</button></p>
</form>`;
}

function renderMinted(token: string, label: string, kind: string, scopes: readonly string[]): string {
  return `<h1>Credential minted</h1>
<p>${escape(label)} &middot; ${escape(kind)} &middot; ${scopes.map((s) => `<code>${escape(s)}</code>`).join(' ')}</p>
<div class="callout"><p><strong>This is the only time the token is shown.</strong> Copy it now; the Registry keeps only its hash.</p>
<p><code style="font-size:1.05em;user-select:all">${escape(token)}</code></p></div>
<p>Present it as <code>Authorization: Bearer &lt;token&gt;</code>, or as <code>CP_REGISTRY_TOKEN</code> in an MCP configuration. If it is ever exposed, revoke it on the <a href="/account">account page</a>; a revoked token stops working immediately.</p>`;
}
