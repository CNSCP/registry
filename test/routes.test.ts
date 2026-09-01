/**
 * The Part One HTTP surface — §9.1, §4.4.
 *
 * Fastify's `inject()` runs the real routing, parsing and handlers without a
 * listening socket, so none of this needs a server or a database.
 *
 * The seam tests are the ones that matter. `POST /internal/authorizes` takes
 * the actor's identity FROM THE REQUEST BODY — that is correct, because it is
 * Part Two's job to have authenticated the person — which makes an
 * unauthenticated seam not an information leak but a complete authorization
 * bypass for anyone who can reach the port. It shipped that way in the first
 * cut of this repo and a review caught it. These tests exist so it cannot
 * happen twice.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerPartOneRoutes } from '../src/part-one/routes.ts';
import { MemoryOwnershipStore } from '../src/part-one/memory-store.ts';
import type { Allocation, Organization } from '../src/part-one/types.ts';

const TOKEN = 'a'.repeat(48);

function organization(id: string, name: string, isOperator = false): Organization {
  return { id, name, website: 'https://example.org', contact_email: 'x@example.org', status: 'active', is_operator: isOperator };
}

function allocation(tlp: string, orgId: string, overrides: Partial<Allocation> = {}): Allocation {
  return {
    id: `alloc-${tlp}`,
    tlp,
    org_id: orgId,
    status: 'active',
    class: 'standard',
    allocated_at: new Date('2026-01-01'),
    expires_at: null,
    grandfathered: false,
    pending_claimant: null,
    closed_to_registration: false,
    notes: null,
    ...overrides,
  };
}

let app: FastifyInstance;

before(async () => {
  const store = new MemoryOwnershipStore({
    organizations: [organization('org-acme', 'Acme Corp'), organization('org-op', 'Padi, Inc.', true)],
    allocations: [
      allocation('acme', 'org-acme'),
      allocation('onuma', 'org-op', { grandfathered: true, pending_claimant: 'ONUMA' }),
    ],
    memberships: [{ org_id: 'org-acme', user_id: 'user-1', role: 'admin' }],
    authorizations: [],
  });

  app = Fastify();
  await registerPartOneRoutes(app, { store, internalToken: TOKEN });
  await app.ready();
});

after(async () => {
  await app.close();
});

describe('the seam requires a bearer token (§4.4)', () => {
  const body = { actor: { userId: 'user-1' }, name: 'acme.meter' };

  test('no Authorization header → 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/internal/authorizes', payload: body });
    assert.equal(response.statusCode, 401);
    // And it must not leak the decision it would have made.
    assert.ok(!response.body.includes('allowed'));
  });

  test('wrong token → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: { authorization: `Bearer ${'b'.repeat(48)}` },
      payload: body,
    });
    assert.equal(response.statusCode, 401);
  });

  test('a token of the right length but wrong content → 401', async () => {
    // Guards the timingSafeEqual path specifically: equal lengths reach the
    // comparison rather than short-circuiting on length.
    const almost = TOKEN.slice(0, -1) + 'b';
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: { authorization: `Bearer ${almost}` },
      payload: body,
    });
    assert.equal(response.statusCode, 401);
  });

  test('a correct prefix of the token → 401, not a partial match', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: { authorization: `Bearer ${TOKEN.slice(0, 20)}` },
      payload: body,
    });
    assert.equal(response.statusCode, 401);
  });

  test('the raw token without the Bearer scheme → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: { authorization: TOKEN },
      payload: body,
    });
    assert.equal(response.statusCode, 401);
  });

  test('the correct token → the decision', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });
    assert.equal(response.statusCode, 200);
    const decision = response.json();
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'holder-member');
  });

  test('a denial is a 200 — it is a successful answer to the question asked', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { actor: { userId: 'nobody' }, name: 'acme.meter' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().allowed, false);
  });

  test('the server refuses to start without a usable token', async () => {
    const store = new MemoryOwnershipStore({});
    for (const bad of ['', 'short', 'a'.repeat(31)]) {
      const instance = Fastify();
      await assert.rejects(
        () => registerPartOneRoutes(instance, { store, internalToken: bad }),
        /at least 32 characters/,
        `token "${bad}" was accepted`,
      );
      await instance.close();
    }
  });
});

describe('the seam validates its input', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  test('a missing body, actor or name → 400', async () => {
    for (const payload of [{}, { name: 'acme.meter' }, { actor: { userId: 'user-1' } }, { actor: {}, name: 'a.b' }]) {
      const response = await app.inject({ method: 'POST', url: '/internal/authorizes', headers: auth, payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  });

  test('a non-string name → 400, not a 500', async () => {
    // Without the typeof check this reached Buffer.byteLength and threw.
    for (const name of [5, {}, [], true, null]) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/authorizes',
        headers: auth,
        payload: { actor: { userId: 'user-1' }, name },
      });
      assert.equal(response.statusCode, 400, `name ${JSON.stringify(name)} produced ${response.statusCode}`);
    }
  });

  test('a non-string userId → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: auth,
      payload: { actor: { userId: 42 }, name: 'acme.meter' },
    });
    assert.equal(response.statusCode, 400);
  });

  test('an unknown intent → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/authorizes',
      headers: auth,
      payload: { actor: { userId: 'user-1' }, name: 'acme.meter', intent: 'delete' },
    });
    assert.equal(response.statusCode, 400);
  });

  test('both valid intents are accepted', async () => {
    for (const intent of ['register', 'publish']) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/authorizes',
        headers: auth,
        payload: { actor: { userId: 'user-1' }, name: 'acme.meter', intent },
      });
      assert.equal(response.statusCode, 200, intent);
    }
  });
});

describe('the public allocation endpoint (§9.1)', () => {
  test('returns holder and status', async () => {
    const response = await app.inject({ method: 'GET', url: '/allocations/acme' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.reference, 'cp:acme');
    assert.equal(body.status, 'active');
    assert.equal(body.holder.name, 'Acme Corp');
  });

  test('NEVER leaks membership, scopes, or verification evidence', async () => {
    // Who holds a Prefix is public; who may act under it is the holder's
    // business. A regression here is a privacy leak, not a cosmetic one.
    const response = await app.inject({ method: 'GET', url: '/allocations/acme' });
    const raw = response.body;
    for (const forbidden of ['user-1', 'member', 'authorization', 'scope', 'verification', 'org-acme', 'contact_email']) {
      assert.ok(!raw.includes(forbidden), `the allocation page leaked "${forbidden}"`);
    }
  });

  test('names a pending claimant, so a spoken-for Prefix cannot be raced (§10.2)', async () => {
    const response = await app.inject({ method: 'GET', url: '/allocations/onuma' });
    assert.equal(response.json().pending_claimant, 'ONUMA');
  });

  test('an unallocated Prefix → 404 with the policy that applies', async () => {
    const response = await app.inject({ method: 'GET', url: '/allocations/nobody' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().allocated, false);
  });

  test('a spec-reserved Prefix reports why it is unavailable', async () => {
    const response = await app.inject({ method: 'GET', url: '/allocations/test' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().policy.because, 'spec-reserved');
  });

  test('a malformed Prefix → 400', async () => {
    for (const bad of ['Acme', 'acme.meter', 'acme_x']) {
      const response = await app.inject({ method: 'GET', url: `/allocations/${encodeURIComponent(bad)}` });
      assert.equal(response.statusCode, 400, bad);
    }
  });

  test('no session or token is needed — the namespace is public', async () => {
    const response = await app.inject({ method: 'GET', url: '/allocations/acme' });
    assert.equal(response.statusCode, 200);
  });
});

describe('published policy and reference parsing', () => {
  test('the reserved and withheld lists are served', async () => {
    const response = await app.inject({ method: 'GET', url: '/policy/prefixes' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.spec_reserved.length, 2);
    assert.ok(body.withheld.some((w: { tlp: string }) => w.tlp === 'proto'));
  });

  test('one Prefix reports its availability and the reason', async () => {
    const reserved = await app.inject({ method: 'GET', url: '/policy/prefixes/example' });
    assert.equal(reserved.json().because, 'spec-reserved');

    const free = await app.inject({ method: 'GET', url: '/policy/prefixes/northwind' });
    assert.equal(free.json().available, true);
  });

  test('references parse, and the invalid ones say why', async () => {
    const ok = await app.inject({ method: 'GET', url: '/references/parse?ref=cp:acme.meter.flow:2' });
    assert.equal(ok.json().parsed.version, 2);

    const bad = await app.inject({ method: 'GET', url: '/references/parse?ref=CP:acme.meter' });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /documentary/);

    const missing = await app.inject({ method: 'GET', url: '/references/parse' });
    assert.equal(missing.statusCode, 400);
  });

  test('health answers without touching the store', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
  });
});
