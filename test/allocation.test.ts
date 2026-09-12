/**
 * The §9.2 operator act — allocating a new Top Level Prefix.
 *
 * The Phase 0 order of operations the operator asserted in session: no name
 * may be registered beneath a Prefix until the Prefix is allocated, and the
 * allocation is itself a guarded, audited, evidence-bearing ruling — never a
 * side effect. What these tests pin down:
 *
 *   - the 'operator' scope guards the act; an authoring credential is refused
 *   - policy is consulted and never overridden (spec-reserved, withheld)
 *   - dry_run rehearses every check and provably writes nothing
 *   - the ruling flips the seam: register-beneath fails before, works after
 *   - everything lands in the audit chain, which stays intact
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { registerAuthoringRoutes, type Credential } from '../src/part-two/routes.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';

const OPERATOR: Credential = {
  token: 'operator-'.padEnd(40, 'o'),
  userId: '',
  kind: 'human',
  scopes: ['register', 'steward', 'release', 'publish', 'deprecate', 'operator'],
};
const AUTHOR: Credential = {
  token: 'author-'.padEnd(40, 'a'),
  userId: '',
  kind: 'human',
  scopes: ['register', 'steward', 'release', 'publish', 'deprecate'],
};

const auth = (c: Credential) => ({ authorization: `Bearer ${c.token}` });

const RULING = {
  tlp: 'cimetrics',
  organization: { name: 'Cimetrics Inc.', website: 'https://cimetrics.com' },
  evidence: 'test ruling: operator verified the claimant controls cimetrics.com',
};

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await applySeed(client);
    for (const [credential, subject] of [
      [OPERATOR, 'oidc|operator'],
      [AUTHOR, 'oidc|author'],
    ] as const) {
      const user = await client.query<{ id: string }>(
        `INSERT INTO app_user (oidc_subject, email) VALUES ($1, $2) RETURNING id`,
        [subject, `${subject.slice(5)}@example.org`],
      );
      credential.userId = user.rows[0]!.id;
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  app = Fastify();
  await registerAuthoringRoutes(app, {
    pool: db,
    ownership: new PgOwnershipStore(db),
    credentials: [OPERATOR, AUTHOR],
  });
  await registerResolutionRoutes(app, { db, html: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

async function allocationCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM allocation`);
  return Number(rows[0]!.n);
}

describe('the scope guard (§15.2)', () => {
  test('an authoring credential is refused — 403 naming the missing scope', async () => {
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(AUTHOR), payload: RULING,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'auth.scope');
    assert.equal(response.json().required_scope, 'operator');
  });

  test('no credential at all is a 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/operator/allocations', payload: RULING });
    assert.equal(response.statusCode, 401);
  });
});

describe('policy is consulted and never overridden (§3.2)', () => {
  test('spec-reserved: test and example are nobody’s to allocate', async () => {
    for (const tlp of ['test', 'example']) {
      const response = await app.inject({
        method: 'POST', url: '/operator/allocations', headers: auth(OPERATOR),
        payload: { ...RULING, tlp },
      });
      assert.equal(response.statusCode, 422, tlp);
      assert.equal(response.json().code, 'allocation.tlp.unavailable', tlp);
    }
  });

  test('withheld: the operator plane’s own path cannot become an allocation', async () => {
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(OPERATOR),
      payload: { ...RULING, tlp: 'operator' },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'allocation.tlp.unavailable');
  });

  test('already allocated: one holder at a time (spec §7.1) — 409', async () => {
    // `onuma` rather than `padi`: padi is ALSO withheld, and policy is
    // consulted first, so it refuses as unavailable. onuma is allocated
    // (pending-claimant) without being withheld — the pure §7.1 case.
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(OPERATOR),
      payload: { ...RULING, tlp: 'onuma' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'allocation.tlp.already-allocated');
  });

  test('a ruling without evidence is not a ruling', async () => {
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(OPERATOR),
      payload: { ...RULING, tlp: 'evidenceless', evidence: 'trust me' },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'allocation.evidence.missing');
  });
});

describe('the act, end to end', () => {
  test('before the ruling, registration beneath the Prefix is refused for everyone', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/cimetrics.ak', headers: auth(OPERATOR),
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  test('dry_run rehearses the ruling and provably writes nothing', async () => {
    const beforeCount = await allocationCount();
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations?dry_run=true', headers: auth(OPERATOR), payload: RULING,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().allocatable, true);
    assert.equal(response.json().dry_run, true);
    assert.equal(await allocationCount(), beforeCount);
  });

  test('the ruling applies: organization created, allocation active, membership granted', async () => {
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(OPERATOR),
      payload: { ...RULING, term_years: 2, member_user_id: AUTHOR.userId, notes: 'Allocated in session, test ruling.' },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(body.allocated, true);
    assert.equal(body.holder, 'Cimetrics Inc.');
    assert.equal(body.organization_created, true);
    assert.ok(body.expires_at, 'the §8.2 term is recorded');

    const { rows } = await db.query(
      `SELECT status, class, grandfathered FROM allocation WHERE tlp = 'cimetrics'`,
    );
    assert.deepEqual(rows[0], { status: 'active', class: 'standard', grandfathered: false });
  });

  test('and the seam flips: the day-one member registers cimetrics.ak', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/cimetrics.ak', headers: auth(AUTHOR),
    });
    assert.equal(response.statusCode, 201, response.body);

    // A non-member is still refused — the allocation authorizes its holder,
    // not the world.
    const stranger = await app.inject({
      method: 'PUT', url: '/cimetrics.other', headers: auth(OPERATOR),
    });
    assert.equal(stranger.statusCode, 403, stranger.body);
  });

  test('the allocation page and root index answer for the new Prefix', async () => {
    const page = await app.inject({ method: 'GET', url: '/cimetrics' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().holder, 'Cimetrics Inc.');
    assert.equal(page.json().grandfathered, false);
    assert.ok(page.json().names.some((n: { name: string }) => n.name === 'cimetrics.ak'));

    const index = await app.inject({ method: 'GET', url: '/' });
    const entry = (index.json().allocations as { tlp: string; holder: string }[]).find(
      (a) => a.tlp === 'cimetrics',
    );
    assert.ok(entry, 'the root index lists the new Prefix');
    assert.equal(entry!.holder, 'Cimetrics Inc.');
  });

  test('a second ruling for the same Prefix is a 409, and the org is not duplicated', async () => {
    const response = await app.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(OPERATOR), payload: RULING,
    });
    assert.equal(response.statusCode, 409);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM organization WHERE name = 'Cimetrics Inc.'`,
    );
    assert.equal(rows[0]!.n, '1');
  });

  test('every step landed in the audit chain, and the chain is intact', async () => {
    const { rows: events } = await db.query<{ action: string }>(
      `SELECT action FROM audit_event
        WHERE action IN ('organization.create', 'allocation.create', 'member.add')
          AND rationale LIKE '%cimetrics%'
        ORDER BY seq`,
    );
    assert.deepEqual(
      events.map((e) => e.action),
      ['organization.create', 'allocation.create', 'member.add'],
    );

    // Zero rows from audit_chain_verify proves integrity (§4.3).
    const { rows } = await db.query(`SELECT * FROM audit_chain_verify(1)`);
    assert.equal(rows.length, 0);
  });
});
