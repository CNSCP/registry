/**
 * Identity — design §15.3, migration 11.
 *
 * The linking rule in its fixed order; sessions as browser state that is not
 * a credential; the account view.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import {
  linkOrCreate, IdentityRefused,
  createSession, findSession, touchSession, revokeSession, signSessionId, verifySessionCookie,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, accountView,
} from '../src/identity/store.ts';
import { mint } from '../src/credentials/store.ts';
import { verify } from '../src/audit.ts';

let harness: Harness;
let db: pg.Pool;
let orgId: string;
let preCreated: string; // an app_user the operator made with `user add`

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
  await inTx(async (c) => {
    orgId = (await applySeed(c)).orgId;
    const u = await c.query<{ id: string }>(
      `INSERT INTO app_user (oidc_subject, email, display_name) VALUES ('local|matt@example.org', 'Matt@Example.org', 'Matt') RETURNING id`,
    );
    preCreated = u.rows[0]!.id;
    await c.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'author')`, [orgId, preCreated]);
  });
});

after(async () => {
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

async function actions(userId: string): Promise<string[]> {
  const { rows } = await db.query<{ action: string }>(`SELECT action FROM audit_event WHERE subject_id = $1 ORDER BY seq`, [userId]);
  return rows.map((r) => r.action);
}

describe('the linking rule', () => {
  test('rule 3: a verified email nobody carries creates a user, audited as self-registration', async () => {
    const r = await inTx((c) => linkOrCreate(c, { provider: 'google', subject: 'g-1', email: 'new@example.org', emailVerified: true, displayName: 'New Person' }));
    assert.equal(r.outcome, 'created');
    const u = await db.query<{ email: string; display_name: string; oidc_subject: string }>(`SELECT email, display_name, oidc_subject FROM app_user WHERE id = $1`, [r.userId]);
    assert.equal(u.rows[0]!.email, 'new@example.org');
    assert.equal(u.rows[0]!.display_name, 'New Person');
    assert.equal(u.rows[0]!.oidc_subject, 'google|g-1');
    assert.deepEqual(await actions(r.userId), ['user.create']);
  });

  test('rule 1: the same provider subject is the same user, whatever the email now says', async () => {
    const first = await inTx((c) => linkOrCreate(c, { provider: 'google', subject: 'g-1', email: 'renamed@example.org', emailVerified: true }));
    assert.equal(first.outcome, 'known');
    const u = await db.query<{ email: string }>(`SELECT email FROM app_user WHERE id = $1`, [first.userId]);
    assert.equal(u.rows[0]!.email, 'new@example.org', 'email on the user is untouched');
    assert.deepEqual(await actions(first.userId), ['user.create'], 'no new audit event for a known identity');
  });

  test('rule 2: a verified email matching exactly one existing user attaches to it — the operator-created row is claimed, case-insensitively', async () => {
    const r = await inTx((c) => linkOrCreate(c, { provider: 'google', subject: 'g-matt', email: 'matt@example.org', emailVerified: true, displayName: 'Matt H' }));
    assert.equal(r.outcome, 'linked');
    assert.equal(r.userId, preCreated);
    assert.deepEqual(await actions(preCreated), ['user.identity_link']);
    const m = await db.query(`SELECT 1 FROM member WHERE user_id = $1 AND org_id = $2`, [preCreated, orgId]);
    assert.equal(m.rowCount, 1, 'memberships granted in advance are already his');
  });

  test('rule 2 again: a second provider with the same email joins the same user, not a new one', async () => {
    const r = await inTx((c) => linkOrCreate(c, { provider: 'github', subject: '12345', email: 'MATT@example.org', emailVerified: true }));
    assert.equal(r.outcome, 'linked');
    assert.equal(r.userId, preCreated);
    const ids = await db.query<{ provider: string }>(`SELECT provider FROM user_identity WHERE app_user_id = $1 ORDER BY provider`, [preCreated]);
    assert.deepEqual(ids.rows.map((x) => x.provider).sort(), ['github', 'google']);
    const users = await db.query(`SELECT 1 FROM app_user WHERE lower(email) = 'matt@example.org'`);
    assert.equal(users.rowCount, 1);
  });

  test('an unverified email never links and never creates; nothing is written', async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM app_user`);
    await assert.rejects(
      inTx((c) => linkOrCreate(c, { provider: 'github', subject: '999', email: 'matt@example.org', emailVerified: false })),
      (e: unknown) => e instanceof IdentityRefused && e.code === 'email-unverified',
    );
    const after_ = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM app_user`);
    assert.equal(after_.rows[0]!.n, before.rows[0]!.n);
    const ids = await db.query(`SELECT 1 FROM user_identity WHERE subject = '999'`);
    assert.equal(ids.rowCount, 0);
  });

  test('a verified email carried by more than one user is refused for an operator to resolve', async () => {
    await db.query(`INSERT INTO app_user (oidc_subject, email) VALUES ('local|dup-a', 'dup@example.org'), ('local|dup-b', 'DUP@example.org')`);
    await assert.rejects(
      inTx((c) => linkOrCreate(c, { provider: 'google', subject: 'g-dup', email: 'dup@example.org', emailVerified: true })),
      (e: unknown) => e instanceof IdentityRefused && e.code === 'email-ambiguous',
    );
  });

  test('the audit chain is intact after all of it', async () => {
    assert.equal(await verify(db), null);
  });
});

describe('sessions', () => {
  const secret = 's'.repeat(64);

  test('a signed cookie round-trips; a tampered or unsigned one does not', () => {
    const cookie = signSessionId('abc123', secret);
    assert.equal(verifySessionCookie(cookie, secret), 'abc123');
    assert.equal(verifySessionCookie(cookie.slice(0, -1) + '0', secret), null);
    assert.equal(verifySessionCookie('abc123', secret), null);
    assert.equal(verifySessionCookie(cookie, 'other-secret'), null);
    assert.equal(verifySessionCookie(undefined, secret), null);
  });

  test('a session is found while live, idles out, expires absolutely, and can be revoked', async () => {
    const t0 = new Date('2026-09-12T10:00:00Z');
    const { id } = await createSession(db, preCreated, t0);
    const live = await findSession(db, id, new Date(t0.getTime() + 1000));
    assert.ok(live);
    assert.equal(live.userId, preCreated);

    // Idle expiry: silent for longer than SESSION_IDLE_MS.
    assert.equal(await findSession(db, id, new Date(t0.getTime() + SESSION_IDLE_MS + 1)), null);
    // ...unless it was touched in between.
    await touchSession(db, live.rowId, new Date(t0.getTime() + SESSION_IDLE_MS - 1000));
    assert.ok(await findSession(db, id, new Date(t0.getTime() + SESSION_IDLE_MS + 1)));

    // Absolute expiry regardless of touching.
    await touchSession(db, live.rowId, new Date(t0.getTime() + SESSION_ABSOLUTE_MS - 1000));
    assert.equal(await findSession(db, id, new Date(t0.getTime() + SESSION_ABSOLUTE_MS + 1)), null);

    // Revocation.
    const { id: id2 } = await createSession(db, preCreated);
    const s2 = await findSession(db, id2);
    assert.ok(s2);
    await revokeSession(db, s2.rowId);
    assert.equal(await findSession(db, id2), null);
  });

  test('the database holds only a hash of the session id', async () => {
    const { id } = await createSession(db, preCreated);
    const { rows } = await db.query(`SELECT 1 FROM session WHERE token_hash = $1`, [id]);
    assert.equal(rows.length, 0);
  });
});

describe('the account view', () => {
  test('shows identities, memberships with the Prefixes they reach, and credentials newest first', async () => {
    await inTx((c) => mint(c, { userId: preCreated, kind: 'human', scopes: ['register', 'publish'], label: 'first', by: 'matt@example.org' }));
    await inTx((c) => mint(c, { userId: preCreated, kind: 'agent', principal: 'matt@example.org', scopes: ['register'], label: 'second', by: 'matt@example.org' }));
    const view = await accountView(db, preCreated);
    assert.ok(view);
    assert.equal(view.user.email, 'Matt@Example.org');
    assert.deepEqual(view.identities.map((i) => i.provider), ['google', 'github']);
    assert.equal(view.memberships.length, 1);
    assert.equal(view.memberships[0]!.role, 'author');
    assert.ok(view.memberships[0]!.prefixes.length > 0, 'the seeded operator organization holds Prefixes');
    assert.deepEqual(view.credentials.map((c) => c.label), ['second', 'first']);
    assert.equal(await accountView(db, '00000000-0000-0000-0000-000000000000'), null);
  });
});
