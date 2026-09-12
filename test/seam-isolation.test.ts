/**
 * §23 testing priority 6 — seam isolation.
 *
 *   "Part Two serves reads with Part One unavailable; every write waits;
 *    governance state never appears in a resolution response."
 *
 * §4.1 rule 2 (as amended 12 Sept 2026): every write requires the seam's
 * answer, because spec §7.3 requires the owner's authorization for every act
 * on a name. The outage is simulated by an OwnershipStore whose every
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
  scopes: ['draft:write', 'publish', 'deprecate'],
};
const STRANGER: Credential = {
  token: 'stranger-'.padEnd(40, 'q'),
  userId: '',
  kind: 'human',
  scopes: ['draft:write', 'publish', 'deprecate'],
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
  const published = await healthy.inject({
    method: 'POST', url: '/padi.isolated/publish', headers: auth(AUTHOR),
    payload: {
      Header: {
        'Name': 'padi.isolated', 'Owner': 'Padi, Inc.', 'Title': 'Isolation test',
        'Provider': 'P', 'Consumer': 'C', 'Description': 'Built while healthy.',
        'Website': 'https://padi.io',
      },
      Properties: { Provider: [{ Name: 'x', Mandatory: 'yes', Propagate: 'no', Description: 'd' }], Consumer: [] },
    },
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

describe('with Part One down: every write waits — the registrant included (spec §7.3; 12 Sept 2026)', () => {
  // Until 12 Sept the recorded registrant could deprecate and steward during an
  // outage. Spec §7.3 requires the owner's authorization for every act on a
  // name, and a registration is a historical fact, not continuing authority:
  // a member since removed, or a former holder's registrant after a transfer,
  // would have kept acting for as long as the seam was down. So nothing is
  // inferred; every write waits, and says so.
  test('the registrant cannot deprecate during the outage', async () => {
    const response = await outage.inject({
      method: 'POST', url: '/padi.isolated:1/deprecate', headers: auth(AUTHOR),
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, 'seam.unavailable');
  });

  test('the registrant cannot update stewardship during the outage', async () => {
    const response = await outage.inject({
      method: 'PATCH', url: '/padi.isolated:1/header', headers: auth(AUTHOR),
      payload: { Website: 'https://moved.example' },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, 'seam.unavailable');
  });

  test('nor release a name', async () => {
    const response = await outage.inject({ method: 'DELETE', url: '/padi.isolated', headers: auth(AUTHOR) });
    assert.equal(response.statusCode, 503, response.body);
  });

  test('a NON-registrant gets the same answer — 503, not 200 and not 403', async () => {
    // A 403 would claim the seam answered "no". It did not answer at all, and
    // the response must say so rather than invent a denial.
    const response = await outage.inject({
      method: 'PATCH', url: '/padi.isolated:1/header', headers: auth(STRANGER),
      payload: { Website: 'https://stranger.example' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'seam.unavailable');
  });

  test('and the version is exactly as it was', async () => {
    const { rows } = await db.query<{ status: string; header_website: string | null }>(
      `SELECT v.status, v.header_website FROM profile_version v JOIN profile p ON p.id = v.profile_id WHERE p.name = 'padi.isolated'`,
    );
    assert.equal(rows[0]!.status, 'published');
    assert.notEqual(rows[0]!.header_website, 'https://moved.example');
  });
});

describe('with Part One down: registration and publication block too (§4.1 rule 2)', () => {
  test('registration blocks with a structured 503 naming the seam', async () => {
    const response = await outage.inject({ method: 'PUT', url: '/padi.brand-new', headers: auth(AUTHOR) });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'seam.unavailable');
    assert.match(response.json().message, /resolution continues to work/);
  });

  test('publication blocks the same way — dry_run included', async () => {
    const payload = { Header: { Name: 'padi.isolated' }, Properties: { Provider: [], Consumer: [] } };
    for (const url of ['/padi.isolated/publish', '/padi.isolated/publish?dry_run=true']) {
      const response = await outage.inject({ method: 'POST', url, headers: auth(AUTHOR), payload });
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

describe('the healthy path: the seam decides, registered_by decides nothing', () => {
  test('a stranger is refused by the SEAM (403)', async () => {
    const response = await healthy.inject({
      method: 'PATCH', url: '/padi.isolated:1/header', headers: auth(STRANGER),
      payload: { Website: 'https://stranger.example' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().gate, 'authorization');
  });

  test('the recorded registrant is refused once their membership is gone', async () => {
    // The registrant column matches, but the seam's answer is what decides —
    // remove the author's membership and the healthy instance refuses despite
    // registered_by matching. Authority is re-derived on every act.
    await db.query(`DELETE FROM member WHERE user_id = $1`, [AUTHOR.userId]);
    const response = await healthy.inject({
      method: 'PATCH', url: '/padi.isolated:1/header', headers: auth(AUTHOR),
      payload: { Website: 'https://moved.example' },
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
