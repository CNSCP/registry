/**
 * Forwarding — design §20.3, §4.4.
 *
 * A stub authoritative host on a real port, and a forwarding instance in
 * front of it. No database: forwarding is a pipe, and what has to be true of
 * a pipe is that what comes out the far end is what went in, that the answer
 * comes back untouched, and that nothing sticks to the walls.
 *
 * The questions worth asking:
 *   - does the CALLER'S credential reach the authoritative host, unaltered,
 *     with the host adding none of its own?
 *   - is the answer the upstream's — status, body and headers — or has this
 *     host had an opinion about it?
 *   - can this host refuse an act the authoritative host would accept? (No.)
 *   - is the credential logged or kept anywhere? (No.)
 *   - what is never forwarded, and what happens when upstream is unreachable?
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';

import { createForwarder, isProfilePath, registerWriteFallthrough } from '../src/distribution/forward.ts';

const TOKEN = 'caller-token-'.padEnd(48, 'c');

type Seen = { method: string; url: string; headers: Record<string, unknown>; body: unknown };

let upstream: FastifyInstance;
let upstreamUrl: string;
let forwarding: FastifyInstance;
let seen: Seen[] = [];
let logged = '';

before(async () => {
  upstream = Fastify();
  upstream.route({
    method: ['PUT', 'POST', 'PATCH', 'DELETE'],
    url: '/*',
    handler: async (request, reply) => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: request.body ?? null });
      if (request.url.includes('refuse')) {
        return reply.code(403).type('application/json').send({ code: 'authorization.no-membership', gate: 'authorization' });
      }
      if (request.url.includes('nobody')) return reply.code(204).send();
      return reply
        .code(201)
        .type('application/cp+json; profile=2026')
        .header('etag', '"upstream-etag"')
        .header('x-cp-status', 'published')
        .send({ ok: true, saw: request.url });
    },
  });
  upstreamUrl = await upstream.listen({ port: 0, host: '127.0.0.1' });

  // A logger writing where the test can read it: the credential must not
  // appear here, and an assertion is the only way that stays true.
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logged += String(chunk);
      done();
    },
  });
  forwarding = Fastify({ logger: { level: 'trace', stream: sink } });
  registerWriteFallthrough(forwarding, createForwarder({ upstream: upstreamUrl }));
  await forwarding.ready();
});

after(async () => {
  await forwarding.close();
  await upstream.close();
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

describe('the pipe (§20.3)', () => {
  test('relays method, path, query, body and the CALLER\'s credential', async () => {
    seen = [];
    const response = await forwarding.inject({
      method: 'POST',
      url: '/padi.relay/publish?dry_run=true',
      headers: { ...auth(), accept: 'application/cp+json; profile=2026' },
      payload: { Header: { Name: 'padi.relay' } },
    });

    assert.equal(seen.length, 1);
    const got = seen[0]!;
    assert.equal(got.method, 'POST');
    assert.equal(got.url, '/padi.relay/publish?dry_run=true', 'path AND query');
    assert.equal(got.headers['authorization'], `Bearer ${TOKEN}`, "the caller's own credential, unaltered");
    assert.equal(got.headers['accept'], 'application/cp+json; profile=2026');
    assert.deepEqual(got.body, { Header: { Name: 'padi.relay' } });
    assert.equal(response.statusCode, 201);
  });

  test('the answer is the upstream\'s — status, body and headers', async () => {
    const response = await forwarding.inject({ method: 'PUT', url: '/padi.relay', headers: auth() });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), { ok: true, saw: '/padi.relay' });
    assert.match(String(response.headers['content-type']), /application\/cp\+json/);
    assert.equal(response.headers['etag'], '"upstream-etag"');
    assert.equal(response.headers['x-cp-status'], 'published');
    assert.equal(response.headers['x-cp-forwarded-to'], upstreamUrl, 'and says where it went');
  });

  test('a refusal is relayed as a refusal: this host refuses nothing of its own', async () => {
    const response = await forwarding.inject({ method: 'POST', url: '/padi.refuse/publish', headers: auth(), payload: {} });
    assert.equal(response.statusCode, 403);
    assert.equal((response.json() as { code: string }).code, 'authorization.no-membership');
    assert.equal(response.headers['x-cp-forwarded-to'], upstreamUrl);
  });

  test('an empty answer stays empty', async () => {
    const response = await forwarding.inject({ method: 'DELETE', url: '/padi.nobody', headers: auth() });
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');
  });

  test('no credential is fine — the upstream decides, not this host', async () => {
    seen = [];
    const response = await forwarding.inject({ method: 'PUT', url: '/padi.anon' });
    assert.equal(seen[0]?.headers['authorization'], undefined, 'nothing of its own is added');
    assert.equal(response.statusCode, 201);
  });

  test('the credential is never logged', async () => {
    assert.ok(logged.length > 0, 'the logger did capture something, or this proves nothing');
    assert.ok(!logged.includes(TOKEN), 'the caller\'s token appears in this host\'s log');
    assert.ok(!logged.toLowerCase().includes('authorization'), 'the header itself appears in this host\'s log');
  });
});

describe('what is never forwarded (§4.4, §20.3)', () => {
  test('only a dotted first segment is a Profile path', () => {
    assert.equal(isProfilePath('/padi.meter.flow'), true);
    assert.equal(isProfilePath('/padi.meter.flow:2/deprecate'), true);
    assert.equal(isProfilePath('/padi.meter.flow/publish?dry_run=true'), true);
    assert.equal(isProfilePath('/operator/allocations'), false);
    assert.equal(isProfilePath('/account'), false);
    assert.equal(isProfilePath('/auth/google'), false);
    assert.equal(isProfilePath('/'), false);
  });

  test('the operator plane, sign-in and the account page get §4.4\'s answer, not a relay', async () => {
    seen = [];
    for (const url of ['/operator/allocations', '/account', '/auth/google/callback', '/']) {
      const response = await forwarding.inject({ method: 'POST', url, headers: auth(), payload: {} });
      assert.equal(response.statusCode, 405, url);
      assert.equal((response.json() as { authoritative: string }).authoritative, upstreamUrl, url);
      assert.equal(response.headers['allow'], 'GET, HEAD', url);
    }
    assert.equal(seen.length, 0, 'nothing reached the authoritative host');
  });
});

describe('when the authoritative host cannot be reached (§20.3)', () => {
  test('502, naming the host, and saying nothing was recorded here', async () => {
    const app = Fastify();
    registerWriteFallthrough(app, createForwarder({ upstream: 'http://127.0.0.1:1', timeoutMs: 1000 }));
    await app.ready();
    try {
      const response = await app.inject({ method: 'PUT', url: '/padi.unreachable', headers: auth() });
      assert.equal(response.statusCode, 502);
      const body = response.json() as { code: string; authoritative: string; message: string };
      assert.equal(body.code, 'forward.unreachable');
      assert.equal(body.authoritative, 'http://127.0.0.1:1');
      assert.match(body.message, /nothing here refused your act/i);
      assert.match(body.message, /whether it had already taken effect/i);
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally {
      await app.close();
    }
  });
});
