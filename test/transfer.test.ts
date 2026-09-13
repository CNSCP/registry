/**
 * Transfer of a Prefix to another holder, and renaming an organization —
 * design §8.4 (operator form) and §9.2, 13 September 2026.
 *
 * The seam is what makes a transfer mean something: the old holder's members
 * lose reach, the new holder's gain it, and the old holder's grants lapse —
 * all without any of those rows being touched. A local instance follows the
 * change through the journal.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { parseCorpus } from '../src/profile/legacy.ts';
import { planImport } from '../src/profile/import.ts';
import { runImport } from '../src/seed/import-profiles.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { registerInstanceRefusals } from '../src/distribution/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { authorizes } from '../src/part-one/authorizes.ts';
import { transferTlp, checkTransferable } from '../src/part-one/transfer.ts';
import { renameOrganization } from '../src/part-one/organization.ts';
import { verify as verifyChain } from '../src/audit.ts';
import { journalFromAudit } from '../src/distribution/store.ts';
import { bootstrap, sync, type Fetch } from '../src/distribution/follower.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')));
const UPSTREAM = 'http://upstream.test';
const SPEC = 'application/cp+json; profile=2026';
const ACTOR = { id: 'anto@padi.io', kind: 'operator' as const, principal: 'anto@padi.io' };

let authoritative: Harness;
let instance: Harness;
let db: pg.Pool;
let upstreamApp: FastifyInstance;
let instanceApp: FastifyInstance;
let operatorOrg: string;
let anto: string;   // member of the operator org
let matt: string;   // member of nothing, then admin of C4SB
let ownership: PgOwnershipStore;

function fetchVia(app: FastifyInstance): Fetch {
  return async (url) => {
    const path = url.startsWith(UPSTREAM) ? url.slice(UPSTREAM.length) : url;
    const response = await app.inject({ method: 'GET', url: path });
    return { status: response.statusCode, json: async () => response.json() };
  };
}

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

before(async () => {
  authoritative = await freshDatabase();
  instance = await freshDatabase();
  db = authoritative.pool;
  ownership = new PgOwnershipStore(db);
  await inTx(async (c) => {
    operatorOrg = (await applySeed(c)).orgId;
    await runImport(c, corpus, planImport(corpus));
    const a = await c.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|anto', 'anto@padi.io') RETURNING id`);
    anto = a.rows[0]!.id;
    await c.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [operatorOrg, anto]);
    const m = await c.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ('google|matt', 'hollar.matthew@gmail.com') RETURNING id`);
    matt = m.rows[0]!.id;
  });
  upstreamApp = Fastify();
  await registerResolutionRoutes(upstreamApp, { db });
  await upstreamApp.ready();
  instanceApp = Fastify();
  await registerResolutionRoutes(instanceApp, { db: instance.pool, role: 'instance', upstream: UPSTREAM });
  registerInstanceRefusals(instanceApp, UPSTREAM);
  await instanceApp.ready();
  await bootstrap(instance.pool, UPSTREAM, fetchVia(upstreamApp));
});

after(async () => {
  await upstreamApp.close();
  await instanceApp.close();
  await authoritative.close();
  await instance.close();
});

const C4SB = 'C4SB (Coalition for Smarter Buildings)';
const evidence = 'Released to its claimant under §10.2 ruling 4. Matt Hollar represents C4SB; attested by the operator from direct contact.';

describe('refusals write nothing', () => {
  test('unknown Prefix, malformed Prefix, thin evidence, unknown destination without --create, same holder', async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_event`);
    const cases: [Parameters<typeof transferTlp>[1], string][] = [
      [{ tlp: 'nothere', to: C4SB, create: true, evidence, actor: ACTOR }, 'allocation.not-found'],
      [{ tlp: 'Not.a.tlp', to: C4SB, create: true, evidence, actor: ACTOR }, 'tlp.malformed'],
      [{ tlp: 'ibb', to: C4SB, create: true, evidence: 'because', actor: ACTOR }, 'evidence.missing'],
      [{ tlp: 'ibb', to: 'C4SB (Coalition for Smarter Buildinsg)', evidence, actor: ACTOR }, 'organization.not-found'],
      [{ tlp: 'ibb', to: 'Padi, Inc.', evidence, actor: ACTOR }, 'organization.same-holder'],
    ];
    for (const [req, code] of cases) {
      const out = await inTx((c) => transferTlp(c, req));
      assert.equal(out.transferred, false, code);
      assert.equal((out as { code: string }).code, code);
    }
    const after_ = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_event`);
    assert.equal(after_.rows[0]!.n, before.rows[0]!.n);
    const orgs = await db.query(`SELECT 1 FROM organization WHERE name LIKE 'C4SB%'`);
    assert.equal(orgs.rowCount, 0, 'no organization was conjured');
  });

  test('a non-active allocation does not transfer', async () => {
    await db.query(`UPDATE allocation SET status = 'locked' WHERE tlp = 'dbp'`);
    const out = await checkTransferable(db, { tlp: 'dbp', to: C4SB, create: true, evidence, actor: ACTOR });
    assert.ok(out.refusal);
    assert.equal(out.refusal.code, 'allocation.not-active');
    await db.query(`UPDATE allocation SET status = 'active' WHERE tlp = 'dbp'`);
  });
});

describe('the transfer', () => {
  test('before: Matt has no reach under ibb; Anto, a member of the operator organization, has', async () => {
    const m = await authorizes(ownership, { userId: matt, kind: 'human' }, 'ibb.zone.new', { intent: 'register' });
    assert.equal(m.allowed, false);
    const a = await authorizes(ownership, { userId: anto, kind: 'human' }, 'ibb.zone.new', { intent: 'register' });
    assert.equal(a.allowed, true);
  });

  test('creates the destination with --create, moves the holder, audits before and after, and touches nothing published', async () => {
    const versionsBefore = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM profile_version v JOIN profile p ON p.id = v.profile_id WHERE p.name LIKE 'ibb.%'`);
    const out = await inTx((c) => transferTlp(c, { tlp: 'ibb', to: C4SB, create: true, website: 'https://c4sb.org', evidence, actor: ACTOR }));
    assert.equal(out.transferred, true);
    if (!out.transferred) return;
    assert.equal(out.from.name, 'Padi, Inc.');
    assert.equal(out.to.name, C4SB);
    assert.equal(out.to.created, true);

    const alloc = await db.query<{ holder: string; grandfathered: boolean; status: string }>(
      `SELECT o.name AS holder, a.grandfathered, a.status::text AS status FROM allocation a JOIN organization o ON o.id = a.org_id WHERE a.tlp = 'ibb'`);
    assert.deepEqual(alloc.rows[0], { holder: C4SB, grandfathered: true, status: 'active' });

    const ev = await db.query<{ action: string; before_payload: Record<string, unknown>; after_payload: Record<string, unknown>; rationale: string }>(
      `SELECT action, before_payload, after_payload, rationale FROM audit_event ORDER BY seq DESC LIMIT 2`);
    assert.deepEqual(ev.rows.map((r) => r.action).sort(), ['allocation.transfer', 'organization.create']);
    const t = ev.rows.find((r) => r.action === 'allocation.transfer')!;
    assert.equal(t.before_payload['holder'], 'Padi, Inc.');
    assert.equal(t.after_payload['holder'], C4SB);
    assert.equal(t.after_payload['tlp'], 'ibb');
    assert.match(t.rationale, /Matt Hollar represents C4SB/);

    const versionsAfter = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM profile_version v JOIN profile p ON p.id = v.profile_id WHERE p.name LIKE 'ibb.%'`);
    assert.equal(versionsAfter.rows[0]!.n, versionsBefore.rows[0]!.n);
    assert.equal(await verifyChain(db), null);
  });

  test('a second Prefix moves to the same organization by name, without --create', async () => {
    const out = await inTx((c) => transferTlp(c, { tlp: 'dbp', to: C4SB, evidence, actor: ACTOR }));
    assert.equal(out.transferred, true);
    if (out.transferred) assert.equal(out.to.created, false);
    const orgs = await db.query(`SELECT 1 FROM organization WHERE name = $1`, [C4SB]);
    assert.equal(orgs.rowCount, 1);
  });

  test('after: Anto has lost reach under ibb, Matt gains it the moment he is made a member; nothing about either row changed', async () => {
    const a = await authorizes(ownership, { userId: anto, kind: 'human' }, 'ibb.zone.new', { intent: 'register' });
    assert.equal(a.allowed, false);
    const c4sb = await db.query<{ id: string }>(`SELECT id FROM organization WHERE name = $1`, [C4SB]);
    await db.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [c4sb.rows[0]!.id, matt]);
    const m = await authorizes(ownership, { userId: matt, kind: 'human' }, 'ibb.zone.new', { intent: 'register' });
    assert.equal(m.allowed, true);
    const still = await authorizes(ownership, { userId: matt, kind: 'human' }, 'padi.new', { intent: 'register' });
    assert.equal(still.allowed, false, 'membership of C4SB reaches C4SB Prefixes and nothing else');
  });

  test("a grant the old holder made stops counting once the Prefix has moved", async () => {
    // Set up a grant on a still-operator-held Prefix, then transfer it.
    const grantee = await db.query<{ id: string }>(`INSERT INTO organization (name, status) VALUES ('Grantee Co', 'active') RETURNING id`);
    const g = await db.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|g', 'g@grantee.example') RETURNING id`);
    await db.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'author')`, [grantee.rows[0]!.id, g.rows[0]!.id]);
    const alloc = await db.query<{ id: string; org_id: string }>(`SELECT id, org_id FROM allocation WHERE tlp = 'c4sb'`);
    await db.query(
      `INSERT INTO authorization_record (allocation_id, scope, grantee_org_id, status, granted_by_org_id) VALUES ($1, 'c4sb.granted', $2, 'active', $3)`,
      [alloc.rows[0]!.id, grantee.rows[0]!.id, alloc.rows[0]!.org_id],
    );
    const beforeT = await authorizes(ownership, { userId: g.rows[0]!.id, kind: 'human' }, 'c4sb.granted.thing', { intent: 'register' });
    assert.equal(beforeT.allowed, true);
    const out = await inTx((c) => transferTlp(c, { tlp: 'c4sb', to: C4SB, evidence, actor: ACTOR }));
    assert.equal(out.transferred, true);
    const afterT = await authorizes(ownership, { userId: g.rows[0]!.id, kind: 'human' }, 'c4sb.granted.thing', { intent: 'register' });
    assert.equal(afterT.allowed, false, 'the grant was from a holder that no longer holds');
  });
});

describe('renaming an organization', () => {
  test('changes the name and nothing else; refuses a taken name and an unknown organization', async () => {
    const membersBefore = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM member WHERE org_id = $1`, [operatorOrg]);
    const out = await inTx((c) => renameOrganization(c, { org: 'Padi, Inc.', to: 'CNS/CP', actor: ACTOR }));
    assert.deepEqual(out, { renamed: true, id: operatorOrg, from: 'Padi, Inc.', to: 'CNS/CP' });
    const org = await db.query<{ name: string; is_operator: boolean }>(`SELECT name, is_operator FROM organization WHERE id = $1`, [operatorOrg]);
    assert.deepEqual(org.rows[0], { name: 'CNS/CP', is_operator: true });
    const membersAfter = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM member WHERE org_id = $1`, [operatorOrg]);
    assert.equal(membersAfter.rows[0]!.n, membersBefore.rows[0]!.n);
    const page = await upstreamApp.inject({ method: 'GET', url: '/padi', headers: { accept: 'application/json' } });
    assert.equal(page.json().holder, 'CNS/CP', 'the allocation page shows the new name');

    const taken = await inTx((c) => renameOrganization(c, { org: 'CNS/CP', to: C4SB, actor: ACTOR }));
    assert.equal(taken.renamed, false);
    const missing = await inTx((c) => renameOrganization(c, { org: 'Padi, Inc.', to: 'Anything', actor: ACTOR }));
    assert.equal(missing.renamed, false);

    // Now "Padi, Inc." is free to be created anew as an ordinary holder.
    const padi = await inTx((c) => transferTlp(c, { tlp: 'padi', to: 'Padi, Inc.', create: true, evidence: "Padi's own Prefix, carved out of the operator organization (§5).", actor: ACTOR }));
    assert.equal(padi.transferred, true);
    if (padi.transferred) assert.equal(padi.to.created, true);
    assert.equal(await verifyChain(db), null);
  });
});

describe('in the journal and on an instance', () => {
  test('transfer and rename are public entries with the current facts; an instance applies them and shows the new holders', async () => {
    const journal = await journalFromAudit(db, 0, 1000);
    const transfers = journal.entries.filter((e) => e.action === 'allocation.transfer');
    assert.equal(transfers.length, 4);
    for (const t of transfers) {
      assert.equal(t.public, true);
      if (t.public) {
        assert.ok(t.allocation, 'courtesy allocation facts attached');
        assert.equal((t.subject as Record<string, unknown>)['holder'], t.allocation!.holder);
      }
    }
    const rename = journal.entries.find((e) => e.action === 'organization.rename');
    assert.ok(rename && rename.public);

    const result = await sync(instance.pool, fetchVia(upstreamApp));
    assert.equal(result.applied > 0, true);
    for (const [tlp, holder] of [['ibb', C4SB], ['dbp', C4SB], ['c4sb', C4SB], ['padi', 'Padi, Inc.'], ['cns', 'CNS/CP']] as const) {
      const page = await instanceApp.inject({ method: 'GET', url: `/${tlp}`, headers: { accept: 'application/json' } });
      assert.equal(page.json().holder, holder, `instance holder of ${tlp}`);
    }
    // And a version beneath a moved Prefix is byte-identical on both.
    const up = await upstreamApp.inject({ method: 'GET', url: '/ibb.zone.temperature', headers: { accept: SPEC } });
    const down = await instanceApp.inject({ method: 'GET', url: '/ibb.zone.temperature', headers: { accept: SPEC } });
    assert.equal(up.statusCode, 200);
    assert.equal(down.body, up.body);
  });
});
