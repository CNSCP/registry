/**
 * §23 testing priority 6 — seam isolation.
 *
 *   "Part Two serves reads and edits with Part One unavailable; governance
 *    state never appears in a resolution response."
 *
 * §4.1 rule 2 is precise about which acts block: "only registration and
 * publication block." The outage is simulated by an OwnershipStore whose every
 * method throws — the seam is not merely answering "no", it is not answering.
 * The distinction matters: a "no" is a 403; an outage is a 503 that names
 * itself and says what still works.
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
import type { OwnershipStore } from '../src/part-one/types.ts';

/** Part One, down. Every question the seam is asked goes unanswered. */
class DownStore implements OwnershipStore {
  async allocationByTlp(): Promise<never> {
    throw new Error('connect ECONNREFUSED (part one is down)');
  }
  async organizationById(): Promise<never> {
    throw new Error('connect ECONNREFUSED (part one is down)');
  }
  async membershipsOfUser(): Promise<never> {
    throw new Error('connect ECONNREFUSED (part one is down)');
  }
  async authorizationsForAllocation(): Promise<never> {
    throw new Error('connect ECONNREFUSED (part one is down)');
  }
}

const AUTHOR: Credential = {
  token: 'author-'.padEnd(40, 'z'),
  userId: '',
  kind: 'human',
  scopes: ['draft:write', 'publish', 'deprecate', 'disclose'],
};
const STRANGER: Credential = {
  token: 'stranger-'.padEnd(40, 'q'),
  userId: '',
  kind: 'human',
  scopes: ['draft:write', 'publish', 'deprecate', 'disclose'],
};

const auth = (c: Credential) => ({ authorization: `Bearer ${c.token}` });

let harness: Harness;
let db: pg.Pool;
/** Healthy seam. */
let healthy: FastifyInstance;
/** Same database, same routes — but Part One is down. */
let outage: FastifyInstance;

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    for (const [credential, subject] of [
      [AUTHOR, 'oidc|author'],
      [STRANGER, 'oidc|stranger'],
    ] as const) {
      const user = await client.query<{ id: string }>(
        `INSERT INTO app_user (oidc_subject, email) VALUES ($1, $2) RETURNING id`,
        [subject, `${subject}@example.org`],
      );
      credential.userId = user.rows[0]!.id;
    }
    // Only the author is a member of the operator org.
    await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      seeded.orgId,
      AUTHOR.userId,
    ]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  healthy = Fastify();
  await registerAuthoringRoutes(healthy, {
    pool: db,
    ownership: new PgOwnershipStore(db),
    credentials: [AUTHOR, STRANGER],
  });
  await registerResolutionRoutes(healthy, { db, html: false });
  await healthy.ready();

  outage = Fastify();
  await registerAuthoringRoutes(outage, {
    pool: db,
    ownership: new DownStore(),
    credentials: [AUTHOR, STRANGER],
  });
  await registerResolutionRoutes(outage, { db, html: false });
  await outage.ready();

  // Set the stage while the seam is healthy: register a name, shape its Draft,
  // publish version 1.
  const register = await healthy.inject({ method: 'PUT', url: '/padi.isolated', headers: auth(AUTHOR) });
  assert.equal(register.statusCode, 201);
  const draft = await healthy.inject({
    method: 'PUT',
    url: '/padi.isolated:draft',
    headers: auth(AUTHOR),
    payload: {
      Header: {
        'Name': 'padi.isolated', 'Owner': 'Padi, Inc.', 'Title': 'Isolation test',
        'Provider': 'P', 'Consumer': 'C', 'Description': 'Built while healthy.',
        'Website': 'https://padi.io',
      },
      Properties: { Provider: [{ Name: 'x', Mandatory: 'yes', Propagate: 'no', Description: 'd' }], Consumer: [] },
    },
  });
  assert.equal(draft.statusCode, 200);
  const published = await healthy.inject({
    method: 'POST', url: '/padi.isolated/publish', headers: auth(AUTHOR),
  });
  assert.equal(published.statusCode, 201);
});

after(async () => {
  await healthy.close();
  await outage.close();
  await harness.close();
});

describe('with Part One down: reads', () => {
  test('resolution never touches the seam, so every read works', async () => {
    for (const url of ['/padi.isolated', '/padi.isolated:1', '/padi.isolated/registration', '/padi']) {
      const response = await outage.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, url);
    }
  });
});

describe('with Part One down: edits keep working for the registrant', () => {
  test('the registrant can keep shaping the Draft', async () => {
    const response = await outage.inject({
      method: 'PUT', url: '/padi.isolated:draft', headers: auth(AUTHOR),
      payload: { Header: { Name: 'padi.isolated' }, Properties: { Provider: [], Consumer: [] } },
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  test('the registrant can deprecate during the outage', async () => {
    const response = await outage.inject({
      method: 'POST', url: '/padi.isolated:1/deprecate', headers: auth(AUTHOR),
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  test('the registrant can update stewardship during the outage', async () => {
    const response = await outage.inject({
      method: 'PATCH', url: '/padi.isolated:1/header', headers: auth(AUTHOR),
      payload: { Website: 'https://moved.example' },
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  test('but a NON-registrant is not quietly granted anything — 503, not 200 and not 403', async () => {
    // A 403 would claim the seam answered "no". It did not answer at all, and
    // the response must say so rather than invent a denial.
    const response = await outage.inject({
      method: 'PUT', url: '/padi.isolated:draft', headers: auth(STRANGER),
      payload: { Header: { Name: 'padi.isolated' } },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'seam.unavailable');
  });
});

describe('with Part One down: only registration and publication block (§4.1 rule 2)', () => {
  test('registration blocks with a structured 503 naming the seam', async () => {
    const response = await outage.inject({ method: 'PUT', url: '/padi.brand-new', headers: auth(AUTHOR) });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'seam.unavailable');
    assert.match(response.json().message, /Draft edits and reads continue to work/);
  });

  test('publication blocks the same way — dry_run included', async () => {
    for (const url of ['/padi.isolated/publish', '/padi.isolated/publish?dry_run=true']) {
      const response = await outage.inject({ method: 'POST', url, headers: auth(AUTHOR) });
      assert.equal(response.statusCode, 503, url);
      assert.equal(response.json().code, 'seam.unavailable', url);
    }
  });

  test('and nothing was written by any blocked act', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile WHERE name = 'padi.brand-new'`,
    );
    assert.equal(rows[0]!.n, '0');
  });
});

describe('the healthy path is unchanged by the fallback existing', () => {
  test('a stranger is refused by the SEAM (403), never by the local fallback', async () => {
    const response = await healthy.inject({
      method: 'PUT', url: '/padi.isolated:draft', headers: auth(STRANGER),
      payload: { Header: { Name: 'padi.isolated' } },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().gate, 'authorization');
  });

  test('the registrant fallback grants nothing while the seam answers', async () => {
    // The registrant column matches, but the seam's answer is what decides —
    // remove the author's membership and the healthy instance refuses despite
    // registered_by matching.
    await db.query(`DELETE FROM member WHERE user_id = $1`, [AUTHOR.userId]);
    const response = await healthy.inject({
      method: 'PUT', url: '/padi.isolated:draft', headers: auth(AUTHOR),
      payload: { Header: { Name: 'padi.isolated' } },
    });
    assert.equal(response.statusCode, 403, 'the fallback must not widen the healthy path');
    // Restore.
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM organization WHERE is_operator`);
    await db.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      rows[0]!.id,
      AUTHOR.userId,
    ]);
  });
});
