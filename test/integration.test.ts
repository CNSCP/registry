/**
 * Everything the DATABASE enforces, proven against a real database.
 *
 * The unit tests cover the TypeScript. These cover what the TypeScript cannot
 * reach: migrations that must actually apply, triggers that must actually fire,
 * constraints that must actually refuse, and the hash chain — which is plpgsql
 * and was, in the first cut of this repo, syntactically invalid while every
 * other test passed.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { record, head, verify, hashSubject } from '../src/audit.ts';
import { applySeed, buildPlan } from '../src/seed/seed.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { authorizes } from '../src/part-one/authorizes.ts';

let harness: Harness;
let db: pg.Pool;

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
});

after(async () => {
  await harness.close();
});

/** Expect a statement to be refused, and return the message. */
async function refused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected the database to refuse this, and it did not');
}

async function newOrg(name: string, status = 'active'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO organization (name, status) VALUES ($1, $2::organization_status) RETURNING id`,
    [name, status],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------

describe('migrations apply', () => {
  test('every table, type and function the code expects exists', async () => {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const expected of [
      'allocation',
      'app_user',
      'audit_event',
      'authorization_record',
      'member',
      'organization',
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }

    const fns = await db.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname LIKE 'audit%' OR proname LIKE 'authorization%'`,
    );
    const fnNames = fns.rows.map((r) => r.proname);
    for (const expected of [
      'audit_event_chain',
      'audit_event_append_only',
      'audit_chain_verify',
      'authorization_record_no_overlap',
      'authorization_record_integrity',
      'authorization_scopes_overlap',
    ]) {
      assert.ok(fnNames.includes(expected), `missing function ${expected}`);
    }
  });

  test('no extension is required — gen_random_uuid and sha256 are core', async () => {
    const { rows } = await db.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql')`,
    );
    assert.deepEqual(rows, [], 'the schema should install no extensions');
  });
});

describe('the audit chain (§4.3)', () => {
  test('an event is chained and hashed on insert', async () => {
    const first = await record(db, {
      actor: 'test',
      actor_kind: 'human',
      action: 'test.first',
      subject_type: 'test',
      subject_id: 'a',
      after: { v: 1 },
    });

    assert.equal(first.prev_event_hash, null, 'the genesis event links to nothing');
    assert.match(first.event_hash, /^[0-9a-f]{64}$/);

    const second = await record(db, {
      actor: 'test',
      actor_kind: 'human',
      action: 'test.second',
      subject_type: 'test',
      subject_id: 'b',
      before: { v: 1 },
      after: { v: 2 },
    });

    assert.equal(second.prev_event_hash, first.event_hash, 'each event links to its predecessor');
    assert.notEqual(second.event_hash, first.event_hash);
  });

  test('audit_chain_verify recomputes the same hashes the trigger wrote', async () => {
    // The two payload expressions live in different functions and must agree
    // field for field. If either drifts, this fails.
    const broken = await verify(db);
    assert.equal(broken, null, `chain reported broken at ${JSON.stringify(broken)}`);
  });

  test('the chain head advances', async () => {
    const before = await head(db);
    await record(db, {
      actor: 'test',
      actor_kind: 'human',
      action: 'test.third',
      subject_type: 'test',
      subject_id: 'c',
    });
    const after = await head(db);
    assert.notEqual(after!.event_hash, before!.event_hash);
    assert.equal(after!.prev_event_hash, before!.event_hash);
  });

  test('audit_event is append-only — UPDATE and DELETE are refused', async () => {
    const onUpdate = await refused(() =>
      db.query(`UPDATE audit_event SET action = 'tampered' WHERE seq = 1`),
    );
    assert.match(onUpdate, /append-only/);

    const onDelete = await refused(() => db.query(`DELETE FROM audit_event WHERE seq = 1`));
    assert.match(onDelete, /append-only/);
  });

  test('a tampered row is detected — the chain is not merely decorative', async () => {
    // Disable the guard to simulate a writer with database access, which is
    // exactly the adversary a hash chain exists for.
    await db.query(`ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update`);
    await db.query(`UPDATE audit_event SET rationale = 'silently changed' WHERE seq = 2`);
    await db.query(`ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update`);

    const broken = await verify(db);
    assert.ok(broken, 'tampering went undetected');
    assert.equal(String(broken!.broken_at), '2');

    // Put it back so later tests see an intact chain.
    await db.query(`ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update`);
    await db.query(`UPDATE audit_event SET rationale = NULL WHERE seq = 2`);
    await db.query(`ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update`);
    assert.equal(await verify(db), null);
  });

  test('a non-human actor must name the person it acted for', async () => {
    const message = await refused(() =>
      db.query(
        `INSERT INTO audit_event (actor, actor_kind, action, subject_type, subject_id)
         VALUES ('ci', 'service', 'x', 'y', 'z')`,
      ),
    );
    assert.match(message, /audit_event_principal_required/);

    // And the application refuses before the database has to.
    await assert.rejects(
      () =>
        record(db, {
          actor: 'ci',
          actor_kind: 'agent',
          action: 'x',
          subject_type: 'y',
          subject_id: 'z',
        }),
      /requires a principal/,
    );
  });

  test('before_hash and after_hash are the application-side subject digests', async () => {
    const subject = { tlp: 'zzz', status: 'active' };
    const event = await record(db, {
      actor: 'test',
      actor_kind: 'human',
      action: 'test.hash',
      subject_type: 'test',
      subject_id: 'h',
      after: subject,
    });
    const { rows } = await db.query<{ after_hash: string }>(
      `SELECT after_hash FROM audit_event WHERE seq = $1`,
      [event.seq],
    );
    assert.equal(rows[0]!.after_hash, hashSubject(subject));
  });
});

describe('allocation constraints (§6.3, §7.1)', () => {
  let orgId: string;

  before(async () => {
    orgId = await newOrg('Constraint Test Co');
  });

  test('a Prefix is held by exactly one party at a time', async () => {
    await db.query(`INSERT INTO allocation (tlp, org_id, status) VALUES ('uniqueco', $1, 'active')`, [
      orgId,
    ]);
    const message = await refused(() =>
      db.query(`INSERT INTO allocation (tlp, org_id, status) VALUES ('uniqueco', $1, 'active')`, [orgId]),
    );
    assert.match(message, /duplicate key|unique/i);
  });

  test('a malformed Prefix is refused by the database, not only by the application', async () => {
    for (const bad of ['Acme', 'acme.meter', 'acme_x', '-acme', 'acme-', 'a'.repeat(64)]) {
      const message = await refused(() =>
        db.query(`INSERT INTO allocation (tlp, org_id, status) VALUES ($1, $2, 'active')`, [bad, orgId]),
      );
      assert.match(message, /allocation_tlp_grammar/, `"${bad}" was accepted`);
    }
  });

  test('there can be only one operator organization', async () => {
    await db.query(`INSERT INTO organization (name, status, is_operator) VALUES ('Op A', 'active', true)`);
    const message = await refused(() =>
      db.query(`INSERT INTO organization (name, status, is_operator) VALUES ('Op B', 'active', true)`),
    );
    assert.match(message, /organization_single_operator/);
    await db.query(`DELETE FROM organization WHERE name = 'Op A'`);
  });
});

describe('authorization_record integrity (§6.4, §8.3)', () => {
  let holder: string;
  let grantee: string;
  let other: string;
  let allocationId: string;
  let otherAllocationId: string;

  before(async () => {
    holder = await newOrg('Holder Body');
    grantee = await newOrg('Committee');
    other = await newOrg('Third Party');

    const a = await db.query<{ id: string }>(
      `INSERT INTO allocation (tlp, org_id, status) VALUES ('holderbody', $1, 'active') RETURNING id`,
      [holder],
    );
    allocationId = a.rows[0]!.id;

    const b = await db.query<{ id: string }>(
      `INSERT INTO allocation (tlp, org_id, status) VALUES ('otherbody', $1, 'active') RETURNING id`,
      [other],
    );
    otherAllocationId = b.rows[0]!.id;
  });

  test('a well-formed scope beneath the allocation is accepted', async () => {
    await db.query(
      `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
       VALUES ($1, 'holderbody.135', $2, 'active')`,
      [allocationId, grantee],
    );
    const { rows } = await db.query(`SELECT 1 FROM authorization_record WHERE scope = 'holderbody.135'`);
    assert.equal(rows.length, 1);
  });

  test('a scope must have at least two segments — a bare Prefix is not a scope', async () => {
    // On a fresh allocation with no live scopes, so the CHECK constraint is
    // what refuses. Postgres fires BEFORE triggers ahead of CHECK constraints,
    // so on an allocation that already has scopes the overlap trigger would
    // reject a bare Prefix first and this would prove nothing.
    const grammarOrg = await newOrg('Grammar Co');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO allocation (tlp, org_id, status) VALUES ('grammarco', $1, 'active') RETURNING id`,
      [grammarOrg],
    );
    const grammarAllocation = rows[0]!.id;

    for (const bad of ['grammarco', 'grammarco.UPPER', 'grammarco..x', 'grammarco.-x', 'grammarco.x_y']) {
      const message = await refused(() =>
        db.query(
          `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
           VALUES ($1, $2, $3, 'active')`,
          [grammarAllocation, bad, grantee],
        ),
      );
      assert.match(message, /authorization_record_scope_grammar/, `"${bad}" was accepted`);
    }
  });

  test('a scope may not lie outside its own allocation’s Prefix', async () => {
    // The cross-tenant hazard: without this, one owner could write scopes over
    // somebody else's namespace.
    const message = await refused(() =>
      db.query(
        `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
         VALUES ($1, 'otherbody.135', $2, 'active')`,
        [allocationId, grantee],
      ),
    );
    assert.match(message, /does not lie beneath the Prefix/);
  });

  test('the holder needs no record beneath its own Prefix', async () => {
    const message = await refused(() =>
      db.query(
        `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
         VALUES ($1, 'holderbody.999', $2, 'active')`,
        [allocationId, holder],
      ),
    );
    assert.match(message, /needs no authorization record/);
  });

  test('live scopes may not overlap, in either direction (§8.3)', async () => {
    const beneath = await refused(() =>
      db.query(
        `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
         VALUES ($1, 'holderbody.135.bacnet', $2, 'active')`,
        [allocationId, other],
      ),
    );
    assert.match(beneath, /overlaps live scope/);

    // And the reverse: a broader scope over an existing narrower one.
    await db.query(
      `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
       VALUES ($1, 'holderbody.223.wg', $2, 'active')`,
      [allocationId, other],
    );
    const above = await refused(() =>
      db.query(
        `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
         VALUES ($1, 'holderbody.223', $2, 'active')`,
        [allocationId, grantee],
      ),
    );
    assert.match(above, /overlaps live scope/);
  });

  test('the segment boundary holds in SQL too — 135 does not overlap 1350', async () => {
    await db.query(
      `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
       VALUES ($1, 'holderbody.1350', $2, 'active')`,
      [allocationId, other],
    );
    const { rows } = await db.query(`SELECT 1 FROM authorization_record WHERE scope = 'holderbody.1350'`);
    assert.equal(rows.length, 1);
  });

  test('a revoked scope frees the name for a re-grant', async () => {
    await db.query(`UPDATE authorization_record SET status = 'revoked' WHERE scope = 'holderbody.135'`);
    await db.query(
      `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
       VALUES ($1, 'holderbody.135', $2, 'active')`,
      [allocationId, other],
    );
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM authorization_record WHERE scope = 'holderbody.135'`,
    );
    assert.equal(rows[0]!.n, 2, 'the revoked record is kept; revocation is not deletion');
  });

  test('an overlap check on one allocation does not block another', async () => {
    // The scan is per-allocation, so `otherbody.135` is unaffected by anything
    // under `holderbody`.
    await db.query(
      `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status)
       VALUES ($1, 'otherbody.135', $2, 'active')`,
      [otherAllocationId, grantee],
    );
    const { rows } = await db.query(`SELECT 1 FROM authorization_record WHERE scope = 'otherbody.135'`);
    assert.equal(rows.length, 1);
  });
});

describe('the bootstrap, end to end (§10.2)', () => {
  let seededDb: Harness;

  before(async () => {
    seededDb = await freshDatabase();
    const client = await seededDb.pool.connect();
    try {
      await client.query('BEGIN');
      await applySeed(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  after(async () => {
    await seededDb.close();
  });

  test('every planned allocation landed', async () => {
    const plan = buildPlan();
    const { rows } = await seededDb.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM allocation`,
    );
    assert.equal(rows[0]!.n, plan.all.length);
  });

  test('`test` has no allocation row, and never may', async () => {
    const { rows } = await seededDb.pool.query(`SELECT 1 FROM allocation WHERE tlp = 'test'`);
    assert.equal(rows.length, 0);
  });

  test('the observed holdings are grandfathered and the infrastructure ones are not', async () => {
    const { rows } = await seededDb.pool.query<{ tlp: string; grandfathered: boolean }>(
      `SELECT tlp, grandfathered FROM allocation WHERE tlp IN ('padi', 'onuma', 'proto', 'realm', 'console')`,
    );
    const byTlp = Object.fromEntries(rows.map((r) => [r.tlp, r.grandfathered]));
    assert.equal(byTlp['padi'], true);
    assert.equal(byTlp['onuma'], true);
    assert.equal(byTlp['proto'], true);
    assert.equal(byTlp['realm'], false, 'a Prefix nobody ever used was not allocated pre-spec');
    assert.equal(byTlp['console'], false);
  });

  test('the withheld Prefixes are closed to registration', async () => {
    const { rows } = await seededDb.pool.query<{ tlp: string }>(
      `SELECT tlp FROM allocation WHERE closed_to_registration ORDER BY tlp`,
    );
    const closed = rows.map((r) => r.tlp);
    for (const expected of ['acme', 'proto', 'xyz', 'console', 'realm']) {
      assert.ok(closed.includes(expected), `${expected} should be closed`);
    }
    assert.ok(!closed.includes('padi'), 'the operator’s working Prefix must stay open');
  });

  test('the seven external claimants are named on their allocations', async () => {
    const { rows } = await seededDb.pool.query<{ tlp: string; pending_claimant: string }>(
      `SELECT tlp, pending_claimant FROM allocation WHERE pending_claimant IS NOT NULL ORDER BY tlp`,
    );
    assert.deepEqual(
      rows.map((r) => r.tlp),
      ['c4sb', 'ibb', 'kubecns', 'novant', 'onuma', 'openjs', 'skycentrics'],
    );
  });

  test('every allocation is audited with its rationale, in one chain', async () => {
    const { rows } = await seededDb.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'allocation.grandfather' AND rationale IS NOT NULL`,
    );
    assert.equal(rows[0]!.n, buildPlan().all.length);
    assert.equal(await verify(seededDb.pool), null, 'the bootstrap chain must be intact');
  });

  test('seeding twice creates nothing and is not an error', async () => {
    const client = await seededDb.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await applySeed(client);
      await client.query('COMMIT');
      assert.equal(result.created, 0);
      assert.equal(result.skipped, buildPlan().all.length);
    } finally {
      client.release();
    }
  });

  test('authorizes() against the seeded database, through the Postgres store', async () => {
    // The seam, end to end: real rows, real store, real decisions.
    const client = await seededDb.pool.connect();
    try {
      const store = new PgOwnershipStore(client);
      const orgId = (
        await client.query<{ id: string }>(`SELECT id FROM organization WHERE is_operator`)
      ).rows[0]!.id;
      const userId = (
        await client.query<{ id: string }>(
          `INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|staff', 'staff@padi.io') RETURNING id`,
        )
      ).rows[0]!.id;
      await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        orgId,
        userId,
      ]);

      const actor = { userId, kind: 'human' as const };

      const ok = await authorizes(store, actor, 'padi.tstat.basic');
      assert.equal(ok.allowed, true, ok.detail);

      const reserved = await authorizes(store, actor, 'test.abc');
      assert.equal(reserved.allowed, false);
      assert.equal(reserved.reason, 'prefix-spec-reserved');

      const bare = await authorizes(store, actor, 'proto');
      assert.equal(bare.allowed, false);
      assert.equal(bare.reason, 'name-single-segment');

      const closed = await authorizes(store, actor, 'proto.new.thing');
      assert.equal(closed.allowed, false);
      assert.equal(closed.reason, 'allocation-closed-to-registration');

      const publishing = await authorizes(store, actor, 'proto.weather.sensor', { intent: 'publish' });
      assert.equal(publishing.allowed, true, 'existing proto.* names stay publishable');

      const unallocated = await authorizes(store, actor, 'nobody.owns-this');
      assert.equal(unallocated.allowed, false);
      assert.equal(unallocated.reason, 'allocation-not-found');
    } finally {
      client.release();
    }
  });
});
