/**
 * Credentials as rows — design §15.2, migration 10.
 *
 * A token is shown once and stored as a hash; the routes look it up by hash;
 * a revoked token is simply absent; scopes on the row are what the token may
 * do. Minting and revoking are audited. The environment credential keeps
 * working beside the table, so a fresh deployment can mint its first row.
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
import { findByToken, hashToken, list, mint, revoke, touch } from '../src/credentials/store.ts';
import { verify } from '../src/audit.ts';

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;
let userId: string;
const ENV: Credential = { token: 'env-bootstrap-'.padEnd(40, 'e'), userId: '', kind: 'human', scopes: ['register', 'publish'] };

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    const u = await client.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|cred', 'anto@padi.io') RETURNING id`);
    userId = u.rows[0]!.id;
    ENV.userId = userId;
    await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [seeded.orgId, userId]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  app = Fastify();
  await registerAuthoringRoutes(app, {
    pool: db,
    ownership: new PgOwnershipStore(db),
    credentials: [ENV],
    credentialStore: { findByToken: (t) => findByToken(db, t), touch: (id) => touch(db, id) },
  });
  await registerResolutionRoutes(app, { db, html: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('minting', () => {
  test('a minted token is 64 hex characters, stored only as its hash, and audited', async () => {
    const { token, id } = await inTx((c) => mint(c, { userId, kind: 'agent', principal: 'anto@padi.io', scopes: ['register', 'steward', 'release'], label: 'Claude Desktop', by: 'anto@padi.io' }));
    assert.match(token, /^[0-9a-f]{64}$/);
    const { rows } = await db.query<{ token_hash: string; scopes: string[] }>(`SELECT token_hash, scopes FROM credential WHERE id = $1`, [id]);
    assert.equal(rows[0]!.token_hash, hashToken(token));
    assert.notEqual(rows[0]!.token_hash, token);
    assert.deepEqual(rows[0]!.scopes, ['register', 'steward', 'release']);
    const events = await db.query<{ action: string }>(`SELECT action FROM audit_event WHERE subject_id = $1`, [id]);
    assert.deepEqual(events.rows.map((r) => r.action), ['credential.mint']);
    assert.equal(await verify(db), null);
  });

  test('an agent without a principal, an empty scope list, or an unknown scope is refused before anything is written', async () => {
    await assert.rejects(inTx((c) => mint(c, { userId, kind: 'agent', scopes: ['register'], label: 'x', by: 'anto@padi.io' })), /principal/);
    await assert.rejects(inTx((c) => mint(c, { userId, kind: 'human', scopes: [], label: 'x', by: 'anto@padi.io' })), /no scopes/);
    await assert.rejects(inTx((c) => mint(c, { userId, kind: 'human', scopes: ['draft:write' as never], label: 'x', by: 'anto@padi.io' })), /unknown scope/);
  });
});

describe('authenticating against the table', () => {
  let agentToken: string;
  let agentId: string;
  let personToken: string;

  before(async () => {
    ({ token: agentToken, id: agentId } = await inTx((c) => mint(c, { userId, kind: 'agent', principal: 'anto@padi.io', scopes: ['register', 'steward', 'release'], label: 'agent', by: 'anto@padi.io' })));
    ({ token: personToken } = await inTx((c) => mint(c, { userId, kind: 'human', scopes: ['publish', 'deprecate'], label: 'person', by: 'anto@padi.io' })));
  });

  test('a table credential registers, rehearses, and is refused publication by its scopes', async () => {
    const put = await app.inject({ method: 'PUT', url: '/padi.tabled', headers: { authorization: `Bearer ${agentToken}` } });
    assert.equal(put.statusCode, 201, put.body);
    const doc = { Header: { Name: 'padi.tabled', Owner: 'Padi', Title: 'T', Provider: 'A', Consumer: 'B', Description: 'd', Website: 'https://padi.io' }, Properties: { Provider: [{ Name: 'x', Mandatory: 'yes', Propagate: 'yes', Description: 'x' }], Consumer: [] } };
    const rehearse = await app.inject({ method: 'POST', url: '/padi.tabled/publish?dry_run=true', headers: { authorization: `Bearer ${agentToken}` }, payload: doc });
    assert.equal(rehearse.statusCode, 200, rehearse.body);
    assert.equal(rehearse.json().publishable, true);
    const publish = await app.inject({ method: 'POST', url: '/padi.tabled/publish', headers: { authorization: `Bearer ${agentToken}` }, payload: doc });
    assert.equal(publish.statusCode, 403);
    assert.equal(publish.json().required_scope, 'publish');
    // The person's token — the split in action.
    const real = await app.inject({ method: 'POST', url: '/padi.tabled/publish', headers: { authorization: `Bearer ${personToken}` }, payload: doc });
    assert.equal(real.statusCode, 201, real.body);
  });

  test('the audit trail names the agent and its principal, then the person', async () => {
    const { rows } = await db.query<{ action: string; actor_kind: string; principal: string | null }>(
      `SELECT action, actor_kind::text, principal FROM audit_event WHERE subject_id IN (
         SELECT id::text FROM profile WHERE name = 'padi.tabled'
         UNION SELECT v.id::text FROM profile_version v JOIN profile p ON p.id = v.profile_id WHERE p.name = 'padi.tabled')
       ORDER BY seq`,
    );
    assert.deepEqual(rows.map((r) => [r.action, r.actor_kind, r.principal]), [
      ['profile.register', 'agent', 'anto@padi.io'],
      ['profile.publish', 'human', null],
    ]);
  });

  test('last_used_at is marked on use', async () => {
    const { rows } = await db.query<{ last_used_at: Date | null }>(`SELECT last_used_at FROM credential WHERE id = $1`, [agentId]);
    assert.ok(rows[0]!.last_used_at instanceof Date);
  });

  test('a revoked token answers 401 from the next request, and revocation is audited', async () => {
    const ok = await inTx((c) => revoke(c, agentId, 'anto@padi.io', 'rotated'));
    assert.equal(ok, true);
    const again = await inTx((c) => revoke(c, agentId, 'anto@padi.io', 'rotated'));
    assert.equal(again, false, 'idempotent');
    const response = await app.inject({ method: 'PUT', url: '/padi.after-revoke', headers: { authorization: `Bearer ${agentToken}` } });
    assert.equal(response.statusCode, 401);
    assert.equal(await findByToken(db, agentToken), null);
    const events = await db.query<{ action: string }>(`SELECT action FROM audit_event WHERE subject_id = $1 ORDER BY seq`, [agentId]);
    assert.deepEqual(events.rows.map((r) => r.action), ['credential.mint', 'credential.revoke']);
  });

  test('a wrong token of the right shape is 401; the environment credential still works beside the table', async () => {
    const wrong = await app.inject({ method: 'PUT', url: '/padi.wrong', headers: { authorization: `Bearer ${'f'.repeat(64)}` } });
    assert.equal(wrong.statusCode, 401);
    const env = await app.inject({ method: 'PUT', url: '/padi.from-env', headers: { authorization: `Bearer ${ENV.token}` } });
    assert.equal(env.statusCode, 201, env.body);
  });

  test('list shows every row, revoked ones included, never a token', async () => {
    const rows = await list(db);
    assert.ok(rows.length >= 3);
    assert.ok(rows.some((r) => r.revoked_at !== null));
    for (const r of rows) assert.ok(!('token' in r) && !('token_hash' in r));
  });
});
