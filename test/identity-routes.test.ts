/**
 * Sign-in, /account, minting and revoking — design §15.3 — driven through
 * the routes with a FakeProvider. Includes the containment test: a session
 * cookie never authenticates an act on the Registry.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { registerAuthoringRoutes } from '../src/part-two/routes.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { registerIdentityRoutes, identityConfigFromEnv, ACCOUNT_SCOPES } from '../src/identity/routes.ts';
import { FakeProvider } from '../src/identity/providers.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { findByToken, touch } from '../src/credentials/store.ts';
import { verify } from '../src/audit.ts';
import { journalFromAudit } from '../src/distribution/store.ts';

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;
let orgId: string;
const SECRET = 'x'.repeat(64);
const google = new FakeProvider('google', { provider: 'google', subject: 'g-anto', email: 'anto@padi.io', emailVerified: true, displayName: 'Anto' });
const github = new FakeProvider('github', { provider: 'github', subject: '77', email: 'someone@example.org', emailVerified: true, displayName: 'Someone' });

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    orgId = (await applySeed(c)).orgId;
    // The operator created Anto's row in advance and made him a member.
    const u = await c.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email, display_name) VALUES ('local|anto@padi.io', 'anto@padi.io', 'Anto B') RETURNING id`);
    await c.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, u.rows[0]!.id]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  app = Fastify();
  await registerAuthoringRoutes(app, {
    pool: db, ownership: new PgOwnershipStore(db), credentials: [],
    credentialStore: { findByToken: (t) => findByToken(db, t), touch: (id) => touch(db, id) },
  });
  await registerIdentityRoutes(app, { pool: db, config: { publicOrigin: 'https://cp.test', sessionSecret: SECRET, providers: [google, github] } });
  await registerResolutionRoutes(app, { db, html: true });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

/** Cookie jar the size of one browser. */
function jar() {
  const store = new Map<string, string>();
  return {
    absorb(res: { headers: Record<string, unknown> }) {
      const raw = res.headers['set-cookie'];
      for (const line of Array.isArray(raw) ? raw : raw ? [String(raw)] : []) {
        const [pair, ...attrs] = String(line).split(';');
        const eq = pair!.indexOf('=');
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        if (attrs.some((a) => a.trim() === 'Max-Age=0') || value === '') store.delete(name);
        else store.set(name, value);
      }
    },
    header(): Record<string, string> {
      return store.size ? { cookie: [...store].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    },
    has(name: string) { return store.has(name); },
  };
}

async function signIn(provider: 'google' | 'github', j = jar()) {
  const start = await app.inject({ method: 'GET', url: `/auth/${provider}` });
  assert.equal(start.statusCode, 302);
  j.absorb(start);
  const state = new URL(start.headers['location'] as string).searchParams.get('state')!;
  const back = await app.inject({ method: 'GET', url: `/auth/${provider}/callback?code=c&state=${state}`, headers: j.header() });
  j.absorb(back);
  return { j, back };
}

async function csrfOf(j: ReturnType<typeof jar>): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/account', headers: j.header() });
  const m = /name="csrf" value="([^"]+)"/.exec(res.body);
  assert.ok(m, 'account page carries a csrf token');
  return m[1]!;
}

const form = (fields: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
};

describe('signing in', () => {
  test('/account without a session offers both providers and sets no cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/account' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /href="\/auth\/google"/);
    assert.match(res.body, /href="\/auth\/github"/);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('the start redirects to the provider with a state the callback must echo; the round-trip cookie is HttpOnly and Secure', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google' });
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers['location']), /^https:\/\/fake\.example\/google\?/);
    const cookie = String(res.headers['set-cookie']);
    assert.match(cookie, /^cp_auth=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/auth/);
  });

  test('a callback whose state does not match the cookie is refused and records nothing', async () => {
    const j = jar();
    const start = await app.inject({ method: 'GET', url: '/auth/google' });
    j.absorb(start);
    const back = await app.inject({ method: 'GET', url: '/auth/google/callback?code=c&state=forged', headers: j.header() });
    assert.equal(back.statusCode, 400);
    assert.match(back.body, /did not match/);
    const ids = await db.query(`SELECT 1 FROM user_identity`);
    assert.equal(ids.rowCount, 0);
  });

  test('a callback with no cookie at all is refused too', async () => {
    const back = await app.inject({ method: 'GET', url: '/auth/google/callback?code=c&state=whatever' });
    assert.equal(back.statusCode, 400);
  });

  test('the provider declining is reported, not treated as a sign-in', async () => {
    const back = await app.inject({ method: 'GET', url: '/auth/github/callback?error=access_denied&error_description=user+said+no' });
    assert.equal(back.statusCode, 400);
    assert.match(back.body, /access_denied/);
  });

  test('a completed sign-in links the pre-created user, opens a session, and lands on /account with memberships shown', async () => {
    const { j, back } = await signIn('google');
    assert.equal(back.statusCode, 302);
    assert.equal(back.headers['location'], '/account');
    assert.ok(j.has('cp_session'));
    assert.ok(!j.has('cp_auth'), 'the round-trip cookie is cleared');
    const account = await app.inject({ method: 'GET', url: '/account', headers: j.header() });
    assert.equal(account.statusCode, 200);
    assert.match(account.body, /anto@padi\.io/);
    assert.match(account.body, /admin/);
    assert.match(account.body, /<code>cp:padi<\/code>/, 'the Prefixes the membership reaches are listed');
    const users = await db.query(`SELECT 1 FROM app_user WHERE email = 'anto@padi.io'`);
    assert.equal(users.rowCount, 1, 'linked, not duplicated');
  });

  test('an unknown provider is a 404; an unverified email is a 403 with nothing written', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/auth/facebook' })).statusCode, 404);
    github.identity = { ...github.identity, emailVerified: false };
    const { back } = await signIn('github');
    assert.equal(back.statusCode, 403);
    assert.match(back.body, /verified email/);
    github.identity = { ...github.identity, emailVerified: true };
    const users = await db.query(`SELECT 1 FROM app_user WHERE email = 'someone@example.org'`);
    assert.equal(users.rowCount, 0);
  });

  test('a new person signing in gets an account with no memberships and is told what that means', async () => {
    const { j } = await signIn('github');
    const account = await app.inject({ method: 'GET', url: '/account', headers: j.header() });
    assert.equal(account.statusCode, 200);
    assert.match(account.body, /No memberships yet/);
  });

  test('sign-out revokes the session; the cookie no longer opens the account', async () => {
    const { j } = await signIn('google');
    const csrf = await csrfOf(j);
    const out = await app.inject({ method: 'POST', url: '/auth/signout', headers: { ...j.header(), 'content-type': 'application/x-www-form-urlencoded' }, payload: form({ csrf }) });
    assert.equal(out.statusCode, 302);
    const before = j.header();
    const res = await app.inject({ method: 'GET', url: '/account', headers: before });
    assert.match(res.body, /Sign in with Google/, 'the old cookie value is dead server-side');
  });
});

describe('minting and revoking on /account', () => {
  test('a signed-in person mints an agent token with author scopes; it works on the API; the audit event is theirs and the journal redacts it', async () => {
    const { j } = await signIn('google');
    const csrf = await csrfOf(j);
    const res = await app.inject({
      method: 'POST', url: '/account/credentials',
      headers: { ...j.header(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ csrf, label: 'Claude Desktop', kind: 'agent', scope: ['register', 'steward', 'release'] }),
    });
    assert.equal(res.statusCode, 201);
    const token = /<code[^>]*>([0-9a-f]{64})<\/code>/.exec(res.body)?.[1];
    assert.ok(token, 'the token is shown once');

    // The token acts on the Registry as the person, with the person as principal.
    const put = await app.inject({ method: 'PUT', url: '/padi.self-minted', headers: { authorization: `Bearer ${token}` } });
    assert.equal(put.statusCode, 201);
    const pub = await app.inject({ method: 'POST', url: '/padi.self-minted/publish', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: {} });
    assert.equal(pub.statusCode, 403);
    assert.equal(pub.json().required_scope, 'publish');

    const ev = await db.query<{ actor: string; actor_kind: string; principal: string }>(
      `SELECT actor, actor_kind, principal FROM audit_event WHERE action = 'credential.mint' ORDER BY seq DESC LIMIT 1`,
    );
    assert.deepEqual(ev.rows[0], { actor: 'anto@padi.io', actor_kind: 'human', principal: 'anto@padi.io' });
    const reg = await db.query<{ actor: string; principal: string }>(`SELECT actor, principal FROM audit_event WHERE action = 'profile.register' ORDER BY seq DESC LIMIT 1`);
    assert.equal(reg.rows[0]!.principal, 'anto@padi.io');

    const journal = await journalFromAudit(db, 0, 500);
    const mintEntry = journal.entries.find((e) => e.action === 'credential.mint');
    assert.ok(mintEntry);
    assert.equal(mintEntry.public, false, 'the journal shows the mint as a redacted link');
    assert.equal(await verify(db), null);
  });

  test('operator cannot be minted here; nor an empty scope list; nor without the form token', async () => {
    const { j } = await signIn('google');
    const csrf = await csrfOf(j);
    const h = { ...j.header(), 'content-type': 'application/x-www-form-urlencoded' };
    const op = await app.inject({ method: 'POST', url: '/account/credentials', headers: h, payload: form({ csrf, label: 'x', kind: 'human', scope: ['register', 'operator'] }) });
    assert.equal(op.statusCode, 400);
    assert.match(op.body, /operator/);
    const empty = await app.inject({ method: 'POST', url: '/account/credentials', headers: h, payload: form({ csrf, label: 'x', kind: 'human' }) });
    assert.equal(empty.statusCode, 400);
    const forged = await app.inject({ method: 'POST', url: '/account/credentials', headers: h, payload: form({ csrf: 'nope', label: 'x', kind: 'human', scope: 'register' }) });
    assert.equal(forged.statusCode, 403);
    const anon = await app.inject({ method: 'POST', url: '/account/credentials', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: form({ csrf, label: 'x', kind: 'human', scope: 'register' }) });
    assert.equal(anon.statusCode, 401);
    assert.deepEqual([...ACCOUNT_SCOPES], ['register', 'steward', 'release', 'publish', 'deprecate']);
  });

  test('revoking your own credential stops it at once; someone else\'s is not yours to see', async () => {
    const { j } = await signIn('google');
    const csrf = await csrfOf(j);
    const h = { ...j.header(), 'content-type': 'application/x-www-form-urlencoded' };
    const minted = await app.inject({ method: 'POST', url: '/account/credentials', headers: h, payload: form({ csrf, label: 'to revoke', kind: 'human', scope: 'register' }) });
    const token = /<code[^>]*>([0-9a-f]{64})<\/code>/.exec(minted.body)![1]!;
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM credential WHERE label = 'to revoke'`);
    const id = rows[0]!.id;

    // The other person cannot revoke it — it is not on their page.
    const other = (await signIn('github')).j;
    const otherCsrf = await csrfOf(other);
    const theirs = await app.inject({ method: 'POST', url: `/account/credentials/${id}/revoke`, headers: { ...other.header(), 'content-type': 'application/x-www-form-urlencoded' }, payload: form({ csrf: otherCsrf }) });
    assert.equal(theirs.statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/padi.still-alive', headers: { authorization: `Bearer ${token}` } })).statusCode, 201);

    const mine = await app.inject({ method: 'POST', url: `/account/credentials/${id}/revoke`, headers: h, payload: form({ csrf }) });
    assert.equal(mine.statusCode, 302);
    assert.equal((await app.inject({ method: 'PUT', url: '/padi.now-dead', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    const ev = await db.query<{ actor_kind: string }>(`SELECT actor_kind FROM audit_event WHERE action = 'credential.revoke' AND subject_id = $1`, [id]);
    assert.equal(ev.rows[0]!.actor_kind, 'human');
  });
});

describe('containment', () => {
  test('a session cookie never authenticates an act: registration and publication with only the cookie answer 401', async () => {
    const { j } = await signIn('google');
    const put = await app.inject({ method: 'PUT', url: '/padi.by-cookie', headers: j.header() });
    assert.equal(put.statusCode, 401);
    const pub = await app.inject({ method: 'POST', url: '/padi.by-cookie/publish', headers: { ...j.header(), 'content-type': 'application/json' }, payload: {} });
    assert.equal(pub.statusCode, 401);
    const gone = await db.query(`SELECT 1 FROM profile WHERE name = 'padi.by-cookie'`);
    assert.equal(gone.rowCount, 0);
  });

  test('resolution is untouched: a profile page renders, and the Account link appears in its chrome', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /href="\/account">Account</);
  });
});

describe('configuration', () => {
  test('none of the variables → null; some → an error naming the missing ones; all → both providers at the origin', () => {
    assert.equal(identityConfigFromEnv({}), null);
    assert.throws(() => identityConfigFromEnv({ CP_OAUTH_GOOGLE_CLIENT_ID: 'x' }), /CP_OAUTH_GOOGLE_CLIENT_SECRET/);
    const all = {
      CP_OAUTH_GOOGLE_CLIENT_ID: 'g', CP_OAUTH_GOOGLE_CLIENT_SECRET: 'gs', CP_OAUTH_GITHUB_CLIENT_ID: 'h', CP_OAUTH_GITHUB_CLIENT_SECRET: 'hs',
      CP_SESSION_SECRET: 's'.repeat(64), CP_PUBLIC_ORIGIN: 'https://cp.cnscp.io/',
    };
    const cfg = identityConfigFromEnv(all);
    assert.ok(cfg);
    assert.equal(cfg.publicOrigin, 'https://cp.cnscp.io');
    assert.deepEqual(cfg.providers.map((p) => p.name), ['google', 'github']);
    assert.throws(() => identityConfigFromEnv({ ...all, CP_SESSION_SECRET: 'short' }), /32 characters/);
  });
});
