/**
 * Identity providers — design §15.3. Both flows driven end to end with an
 * injected fetch: Google's ID token is really signed and really verified.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { GoogleProvider, GitHubProvider, GOOGLE, GITHUB, ProviderError } from '../src/identity/providers.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function jwt(claims: Record<string, unknown>, kid = 'k1', key = privateKey): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

type Handler = (url: string, init?: RequestInit) => { status?: number; json: unknown };
function fakeFetch(handlers: Record<string, Handler>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const h = handlers[url];
    if (!h) throw new Error(`unexpected fetch ${url}`);
    const r = h(url, init);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const NOW = Date.parse('2026-09-12T12:00:00Z');
const redirect = 'https://cp.cnscp.io/auth/google/callback';

describe('Google', () => {
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: GOOGLE.issuer, aud: 'client-1', sub: '1234567890', exp: Math.floor(NOW / 1000) + 60, nonce: 'N',
    email: 'anto@padi.io', email_verified: true, name: 'Anto Budiardjo', ...over,
  });
  function google(idToken: string, calls: string[] = []) {
    return new GoogleProvider({
      clientId: 'client-1', clientSecret: 'secret', now: () => NOW,
      fetch: fakeFetch({
        [GOOGLE.token]: (_u, init) => { calls.push(String(init?.body)); return { json: { id_token: idToken } }; },
        [GOOGLE.jwks]: () => { calls.push('jwks'); return { json: { keys: [jwk] } }; },
      }),
    });
  }

  test('start() carries PKCE, nonce, state and the basic scopes only', () => {
    const p = google('x');
    const s = p.start(redirect);
    const u = new URL(s.url);
    assert.equal(u.origin + u.pathname, GOOGLE.authorization);
    assert.equal(u.searchParams.get('scope'), 'openid email profile');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('state'), s.state);
    assert.equal(u.searchParams.get('nonce'), s.nonce);
    assert.ok(s.codeVerifier.length >= 43);
  });

  test('finish() exchanges the code with the verifier and verifies the ID token against the published key', async () => {
    const calls: string[] = [];
    const p = google(jwt(claims()), calls);
    const id = await p.finish('code-1', redirect, { codeVerifier: 'VERIFIER', nonce: 'N' });
    assert.deepEqual(id, { provider: 'google', subject: '1234567890', email: 'anto@padi.io', emailVerified: true, displayName: 'Anto Budiardjo' });
    assert.match(calls[0]!, /code_verifier=VERIFIER/);
    assert.match(calls[0]!, /grant_type=authorization_code/);
    assert.equal(calls[1], 'jwks');
    // A second token with the same kid does not refetch the keys.
    await p.finish('code-2', redirect, { codeVerifier: 'VERIFIER', nonce: 'N' });
    assert.equal(calls.filter((c) => c === 'jwks').length, 1);
  });

  test('a token that fails any check is refused: signature, nonce, expiry, audience, issuer', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const cases: [string, string][] = [
      [jwt(claims(), 'k1', other), /signature/],
      [jwt(claims({ nonce: 'wrong' })), /nonce/],
      [jwt(claims({ exp: Math.floor(NOW / 1000) - 1 })), /expired/],
      [jwt(claims({ aud: 'someone-else' })), /audience/],
      [jwt(claims({ iss: 'https://evil.example' })), /issuer/],
      [jwt(claims(), 'unknown-kid'), /kid/],
    ].map(([t, re]) => [t as string, String(re)]);
    for (const [token, pattern] of cases) {
      const p = google(token);
      await assert.rejects(p.finish('c', redirect, { codeVerifier: 'v', nonce: 'N' }), (e: unknown) => e instanceof ProviderError && new RegExp(pattern.slice(1, -1)).test(e.message), pattern);
    }
  });

  test('an unverified email comes through as unverified; the linking rule refuses it, not the provider', async () => {
    const p = google(jwt(claims({ email_verified: false })));
    const id = await p.finish('c', redirect, { codeVerifier: 'v', nonce: 'N' });
    assert.equal(id.emailVerified, false);
    assert.equal(id.email, 'anto@padi.io');
  });
});

describe('GitHub', () => {
  function github(emails: unknown, user: unknown = { id: 42, login: 'matt', name: 'Matt Hollar' }, token: unknown = { access_token: 'gho_x' }) {
    const seen: string[] = [];
    const p = new GitHubProvider({
      clientId: 'gh-1', clientSecret: 'gh-secret',
      fetch: fakeFetch({
        [GITHUB.token]: (_u, init) => { seen.push(String(init?.body)); return { json: token }; },
        [GITHUB.user]: (_u, init) => { seen.push(String((init?.headers as Record<string, string>)['authorization'])); return { json: user }; },
        [GITHUB.emails]: () => ({ json: emails }),
      }),
    });
    return { p, seen };
  }

  test('start() asks for the user and email scopes and forbids sign-up-on-the-spot', () => {
    const { p } = github([]);
    const s = p.start('https://cp.cnscp.io/auth/github/callback');
    const u = new URL(s.url);
    assert.equal(u.origin + u.pathname, GITHUB.authorization);
    assert.equal(u.searchParams.get('scope'), 'read:user user:email');
    assert.equal(u.searchParams.get('allow_signup'), 'false');
    assert.equal(u.searchParams.get('state'), s.state);
  });

  test('finish() takes the primary email and its verified flag; the id is the subject', async () => {
    const { p, seen } = github([{ email: 'old@example.org', primary: false, verified: true }, { email: 'hollar.matthew@gmail.com', primary: true, verified: true }]);
    const id = await p.finish('code', 'https://cp.cnscp.io/auth/github/callback');
    assert.deepEqual(id, { provider: 'github', subject: '42', email: 'hollar.matthew@gmail.com', emailVerified: true, displayName: 'Matt Hollar' });
    assert.match(seen[0]!, /client_secret=gh-secret/);
    assert.equal(seen[1], 'Bearer gho_x');
  });

  test('an unverified primary email is reported unverified; a missing access token is a provider error', async () => {
    const { p } = github([{ email: 'x@example.org', primary: true, verified: false }]);
    assert.equal((await p.finish('code', 'r')).emailVerified, false);
    const { p: p2 } = github([], {}, { error: 'bad_verification_code' });
    await assert.rejects(p2.finish('code', 'r'), /bad_verification_code/);
  });
});
