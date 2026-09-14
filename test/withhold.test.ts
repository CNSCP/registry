/**
 * Custody of withheld Prefixes — design §3.2, 14 September 2026.
 *
 * The invariant under test is one §3.2 states and `authorizes()` relies on: a
 * withheld Prefix "is held by the operator, so nothing beneath it is
 * ownerless". The seed makes that true for every entry on the list at the
 * moment it runs. What nothing caught until now is an entry ADDED to the list
 * afterwards, on a Registry that was seeded before: `account` and `auth` were
 * reserved on 12 September and canon, seeded on 11 September, has no row for
 * either. `custodyGaps` is that check, and the last test here is the one that
 * would have failed on 12 September.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { WITHHELD } from '../src/policy.ts';
import { checkWithholdable, custodyGaps, withholdTlp } from '../src/part-one/withhold.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { verify as verifyChain } from '../src/audit.ts';
import { journalFromAudit } from '../src/distribution/store.ts';

const ACTOR = { id: 'anto@padi.io', kind: 'operator' as const, principal: 'anto@padi.io' };

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;
let operatorOrg: string;

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

/**
 * Reproduce the real situation: a Prefix that policy withholds but the
 * database has no row for, exactly as if it had been added to WITHHELD after
 * this Registry was seeded.
 */
async function unseed(tlp: string): Promise<void> {
  await db.query(`DELETE FROM allocation WHERE tlp = $1`, [tlp]);
}

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
  await inTx(async (c) => {
    operatorOrg = (await applySeed(c)).orgId;
  });
  app = Fastify();
  await registerResolutionRoutes(app, { db });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

describe('custody of a withheld Prefix (§3.2)', () => {
  test('a fresh seed leaves no gaps', async () => {
    assert.deepEqual(await custodyGaps(db), []);
  });

  test('a Prefix added to the policy after seeding is reported as a gap', async () => {
    await unseed('account');
    assert.deepEqual(await custodyGaps(db), ['account']);
  });

  test('taking custody allocates it to the operator, reserved and not grandfathered', async () => {
    const outcome = await inTx((c) => withholdTlp(c, { tlp: 'account', actor: ACTOR }));
    assert.equal(outcome.withheld, true);
    assert.equal(outcome.withheld === true && outcome.class, 'path-shadowing');
    assert.equal(outcome.withheld === true && outcome.holder.id, operatorOrg);

    const { rows } = await db.query<{ status: string; class: string; grandfathered: boolean; expires_at: string | null }>(
      `SELECT status, class, grandfathered, expires_at FROM allocation WHERE tlp = 'account'`,
    );
    assert.equal(rows[0]!.status, 'active');
    assert.equal(rows[0]!.class, 'reserved');
    assert.equal(rows[0]!.grandfathered, false);
    assert.equal(rows[0]!.expires_at, null);

    assert.deepEqual(await custodyGaps(db), []);
  });

  test('the act is public, so a follower learns of it — unlike the bootstrap', async () => {
    const { entries } = await journalFromAudit(db, 0, 500);
    const mine = entries.filter((e) => e.public && e.action === 'allocation.create');
    const account = mine.find((e) => JSON.stringify(e).includes('account'));
    assert.ok(account, 'the custody event is projected into the public journal');

    // The bootstrap's own events are not public, and stay that way.
    const grandfather = entries.filter((e) => !e.public && e.action === 'allocation.grandfather');
    assert.ok(grandfather.length > 0, 'the seed wrote grandfather events, and they are redacted');
  });

  test('the chain is intact afterwards', async () => {
    assert.equal(await verifyChain(db), null);
  });

  test('it refuses a Prefix that policy does not withhold', async () => {
    const refusal = await checkWithholdable(db, 'cimetrics');
    assert.equal(refusal?.code, 'tlp.not-withheld');
  });

  test('it refuses a spec-reserved Prefix, which is nobody’s to allocate', async () => {
    for (const tlp of ['example', 'test']) {
      const refusal = await checkWithholdable(db, tlp);
      assert.equal(refusal?.code, 'tlp.spec-reserved');
    }
  });

  test('it refuses a withheld Prefix that is a real holding, not infrastructure', async () => {
    // `padi`, `hello`, `proto`, `acme`, `xyz` are operator-held or documentary:
    // seed inventory, with records beneath them. Custody is for the empty
    // infrastructure names only, and the class is checked before the table —
    // policy first, state second, so the refusal names the real reason.
    assert.equal((await checkWithholdable(db, 'acme'))?.code, 'tlp.not-custodial');
    await unseed('acme');
    assert.equal((await checkWithholdable(db, 'acme'))?.code, 'tlp.not-custodial');
    assert.deepEqual(await custodyGaps(db), [], 'a documentary Prefix is not a custody gap');
  });

  test('it refuses one that is already allocated, and writes nothing', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM audit_event`);
    const outcome = await inTx((c) => withholdTlp(c, { tlp: 'console', actor: ACTOR }));
    assert.equal(outcome.withheld, false);
    assert.equal(outcome.withheld === false && outcome.code, 'tlp.already-allocated');
    const after = await db.query(`SELECT count(*)::int AS n FROM audit_event`);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });

  test('it refuses a malformed Prefix', async () => {
    assert.equal((await checkWithholdable(db, 'Not.A.Prefix'))?.code, 'tlp.malformed');
  });

  test('every path-shadowing and infrastructure entry is custodial by construction', () => {
    // The guard in withhold.ts and the policy list must not drift apart: if a
    // new class appears in WITHHELD, this says so rather than silently
    // excluding it from the gap check.
    const classes = new Set(WITHHELD.map((w) => w.class));
    assert.deepEqual(
      [...classes].sort(),
      ['documentary', 'infrastructure', 'operator-held', 'path-shadowing'],
    );
  });

  test('the allocation page answers for it, which is the point', async () => {
    const response = await app.inject({ method: 'GET', url: '/account' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { tlp: string; holder: string };
    assert.equal(body.tlp, 'account');
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM organization WHERE id = $1`, [operatorOrg]);
    assert.equal(body.holder, rows[0]!.name);
  });
});
