/**
 * Roles on branches — design §6.2, §25 Q7(a), settled 9 October 2026.
 *
 * The rulings, each with its test:
 *   - a branch covers the name itself and everything beneath it, on whole
 *     segments; `reach: name` covers exactly one name
 *   - `*` covers everything the organization may act on: what it holds AND
 *     what a §8.3 grant gives it
 *   - register (claim, release) and publish (publish, deprecate, steward) are
 *     separate, in any combination
 *   - an admin grants only within their own branch, and only to members
 *   - admins add members; removing one takes every role they held
 *   - an organization keeps at least one admin over all of it
 *   - the backfill leaves every member exactly the authority they had
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';

import { authorizes } from '../src/part-one/authorizes.ts';
import { MemoryOwnershipStore } from '../src/part-one/memory-store.ts';
import type { Allocation, Organization, RoleGrant } from '../src/part-one/types.ts';
import { administers, branchProblem, roleCovers } from '../src/part-one/roles.ts';
import {
  addMember,
  grantRole,
  liveRolesOfUser,
  parseRoles,
  removeMember,
  revokeRole,
  RoleError,
  type RoleActor,
} from '../src/part-one/roles.ts';
import { freshDatabase, MIGRATIONS_DIR, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';

// --- The rules on their own ---------------------------------------------------

describe('what a role covers (§6.2)', () => {
  const branch = (b: string) => ({ branch: b, reach: 'branch' as const });
  const name = (b: string) => ({ branch: b, reach: 'name' as const });

  test('a branch covers the name itself and everything beneath it, on whole segments', () => {
    assert.ok(roleCovers(branch('acme.xyz'), 'acme.xyz'));
    assert.ok(roleCovers(branch('acme.xyz'), 'acme.xyz.temp'));
    assert.ok(roleCovers(branch('acme.xyz'), 'acme.xyz.meter.flow'));
    assert.ok(!roleCovers(branch('acme.xyz'), 'acme.xyzzy'));
    assert.ok(!roleCovers(branch('acme.xyz'), 'acme.abc'));
    assert.ok(!roleCovers(branch('acme.xyz'), 'acme'));
  });

  test('a single name covers exactly that name', () => {
    assert.ok(roleCovers(name('acme.xyz.temp'), 'acme.xyz.temp'));
    assert.ok(!roleCovers(name('acme.xyz.temp'), 'acme.xyz.temp.v2'));
  });

  test('an admin administers only within their own branch', () => {
    assert.ok(administers(branch('*'), branch('acme')));
    assert.ok(administers(branch('*'), branch('*')));
    assert.ok(administers(branch('acme.xyz'), branch('acme.xyz')));
    assert.ok(administers(branch('acme.xyz'), name('acme.xyz.temp')));
    assert.ok(administers(branch('acme.xyz'), branch('acme.xyz.temp')));
    assert.ok(!administers(branch('acme.xyz'), branch('acme')));
    assert.ok(!administers(branch('acme.xyz'), branch('acme.abc')));
    assert.ok(!administers(branch('acme.xyz'), branch('*')));
    assert.ok(administers(name('acme.xyz.temp'), name('acme.xyz.temp')));
    assert.ok(!administers(name('acme.xyz.temp'), branch('acme.xyz.temp')), 'an admin of one name cannot grant the branch beneath it');
  });

  test('a branch is *, a Prefix or a name — nothing the grammar refuses', () => {
    for (const ok of ['*', 'acme', 'acme.xyz', 'acme.xyz.temp']) assert.equal(branchProblem(ok), null, ok);
    for (const bad of ['Acme', 'acme..xyz', '', 'acme.x y']) assert.notEqual(branchProblem(bad), null, bad);
  });

  test('roles are register, publish and admin, and nothing else — there is no "author"', () => {
    assert.deepEqual(parseRoles('publish,register'), ['register', 'publish']);
    assert.throws(() => parseRoles('author'), /Unknown role/);
  });
});

// --- The seam ---------------------------------------------------------------------

describe('the seam asks for a role (§9.3)', () => {
  const ORG = { acme: 'org-acme', partner: 'org-partner' };
  const allocation = (tlp: string, org: string): Allocation => ({
    id: `alloc-${tlp}`, tlp, org_id: org, status: 'active', class: 'standard', allocated_at: new Date('2026-01-01'),
    expires_at: null, grandfathered: false, pending_claimant: null, closed_to_registration: false, notes: null,
  });
  const organization = (id: string): Organization => ({ id, name: id, website: null, contact_email: null, status: 'active', is_operator: false });
  const role = (user: string, org: string, branch: string, roles: RoleGrant['roles'], reach: RoleGrant['reach'] = 'branch'): RoleGrant =>
    ({ org_id: org, user_id: user, branch, reach, roles });

  const store = new MemoryOwnershipStore({
    organizations: [organization(ORG.acme), organization(ORG.partner)],
    allocations: [allocation('acme', ORG.acme)],
    memberships: [
      { org_id: ORG.acme, user_id: 'fred', role: 'author' },
      { org_id: ORG.acme, user_id: 'reggie', role: 'author' },
      { org_id: ORG.acme, user_id: 'pat', role: 'author' },
      { org_id: ORG.acme, user_id: 'nobody', role: 'author' },
      { org_id: ORG.partner, user_id: 'pam', role: 'author' },
      { org_id: ORG.partner, user_id: 'idle', role: 'author' },
    ],
    roles: [
      role('fred', ORG.acme, 'acme.xyz', ['register', 'publish']),
      role('reggie', ORG.acme, 'acme.xyz', ['register']),
      role('pat', ORG.acme, 'acme.abc.temp', ['publish'], 'name'),
      role('pam', ORG.partner, '*', ['register', 'publish']),
    ],
    authorizations: [{
      id: 'grant-acme-lab', allocation_id: 'alloc-acme', scope: 'acme.lab', grantee_org_id: ORG.partner,
      granted_by_org_id: ORG.acme, status: 'active', granted_at: new Date('2026-02-01'), expires_at: null,
    }],
  });
  const ask = (user: string, name: string, intent: 'register' | 'publish', role?: 'register' | 'publish') =>
    authorizes(store, { userId: user, kind: 'human' }, name, { intent, ...(role ? { role } : {}) });

  test('membership alone authorizes nothing: no role, refused with no-role naming what is missing', async () => {
    const d = await ask('nobody', 'acme.xyz.temp', 'register');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'no-role');
    assert.match(d.detail, /"register" role covering "acme.xyz.temp"/);
  });

  test('Fred, register+publish on acme.xyz: everything under .xyz, nothing outside it', async () => {
    assert.equal((await ask('fred', 'acme.xyz', 'register')).allowed, true, 'the branch name itself');
    assert.equal((await ask('fred', 'acme.xyz.temp', 'register')).allowed, true);
    assert.equal((await ask('fred', 'acme.xyz.temp', 'publish')).allowed, true);
    assert.equal((await ask('fred', 'acme.xyzzy', 'register')).reason, 'no-role');
    assert.equal((await ask('fred', 'acme.abc.temp', 'publish')).reason, 'no-role');
  });

  test('register without publish: may claim and release, may not publish, deprecate or steward', async () => {
    assert.equal((await ask('reggie', 'acme.xyz.new', 'register')).allowed, true);
    assert.equal((await ask('reggie', 'acme.xyz.new', 'publish', 'register')).allowed, true, 'release: publish intent, register role');
    assert.equal((await ask('reggie', 'acme.xyz.new', 'publish')).reason, 'no-role');
  });

  test('publish on a single name: that Profile and nothing else — not even a name beneath it', async () => {
    assert.equal((await ask('pat', 'acme.abc.temp', 'publish')).allowed, true);
    assert.equal((await ask('pat', 'acme.abc.temp', 'register')).reason, 'no-role', 'publish does not claim names');
    assert.equal((await ask('pat', 'acme.abc.temp.v2', 'publish')).reason, 'no-role');
  });

  test('a §8.3 grantee organization still decides which of its people act: * covers what it was granted', async () => {
    assert.equal((await ask('pam', 'acme.lab.sensor', 'register')).allowed, true);
    assert.equal((await ask('idle', 'acme.lab.sensor', 'register')).reason, 'no-role', 'a member of the grantee with no role');
    assert.equal((await ask('pam', 'acme.xyz.temp', 'register')).reason, 'no-covering-scope', 'and the grant still bounds the organization');
  });
});

// --- The acts, on Postgres -----------------------------------------------------------

describe('granting, revoking, adding and removing (§6.2)', () => {
  let h: Harness;
  let db: pg.PoolClient;
  let org: string;
  const users: Record<string, string> = {};
  const OPERATOR: RoleActor = { kind: 'operator', principal: 'anto@padi.io' };
  const person = (key: string): RoleActor => ({ kind: 'human', userId: users[key]!, email: `${key}@acme.test` });

  before(async () => {
    h = await freshDatabase();
    db = await h.pool.connect();
    await db.query('BEGIN');
    await applySeed(db);
    const o = await db.query<{ id: string }>(`INSERT INTO organization (name, status) VALUES ('Acme', 'active') RETURNING id`);
    org = o.rows[0]!.id;
    await db.query(`INSERT INTO allocation (tlp, org_id, status, class, allocated_at) VALUES ('acmeco', $1, 'active', 'standard', now())`, [org]);
    for (const key of ['jane', 'xavier', 'fred', 'stranger']) {
      const u = await db.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ($1, $2) RETURNING id`, [`oidc|${key}`, `${key}@acme.test`]);
      users[key] = u.rows[0]!.id;
    }
    await db.query('COMMIT');
    // Jane is the first admin, appointed by the operator.
    await addMember(db, { orgId: org, userId: users['jane']!, actor: OPERATOR });
    await grantRole(db, { orgId: org, userId: users['jane']!, branch: '*', roles: ['admin', 'register', 'publish'], actor: OPERATOR });
  });

  after(async () => {
    db.release();
    await h.close();
  });

  // Every act runs in a transaction in production (the CLI, /account); a
  // refused one rolls back. Do the same here, so a refusal raised after a
  // write — the last-admin guard — leaves nothing behind.
  const refused = async (act: () => Promise<unknown>, code: string) => {
    await db.query('BEGIN');
    try {
      await assert.rejects(act(), (e: unknown) => e instanceof RoleError && e.code === code);
    } finally {
      await db.query('ROLLBACK');
    }
  };

  test('an admin adds members, and membership alone grants nothing', async () => {
    assert.deepEqual(await addMember(db, { orgId: org, userId: users['xavier']!, actor: person('jane') }), { added: true });
    assert.deepEqual(await addMember(db, { orgId: org, userId: users['fred']!, actor: person('jane') }), { added: true });
    assert.deepEqual(await liveRolesOfUser(db, users['fred']!), []);
    const d = await authorizes(new PgOwnershipStore(db), { userId: users['fred']!, kind: 'human' }, 'acmeco.xyz.temp', { intent: 'register' });
    assert.equal(d.reason, 'no-role');
  });

  test('a branch admin grants within their branch — and nowhere else', async () => {
    await grantRole(db, { orgId: org, userId: users['xavier']!, branch: 'acmeco.xyz', roles: ['admin'], actor: person('jane') });
    await grantRole(db, { orgId: org, userId: users['fred']!, branch: 'acmeco.xyz.temp', reach: 'name', roles: ['register', 'publish'], actor: person('xavier') });
    await refused(() => grantRole(db, { orgId: org, userId: users['fred']!, branch: 'acmeco.abc', roles: ['publish'], actor: person('xavier') }), 'role.not-admin');
    await refused(() => grantRole(db, { orgId: org, userId: users['fred']!, branch: '*', roles: ['publish'], actor: person('xavier') }), 'role.not-admin');
    const d = await authorizes(new PgOwnershipStore(db), { userId: users['fred']!, kind: 'human' }, 'acmeco.xyz.temp', { intent: 'register' });
    assert.equal(d.allowed, true, d.detail);
  });

  test('roles go only to members, only within what the organization reaches, and never empty', async () => {
    await refused(() => grantRole(db, { orgId: org, userId: users['stranger']!, branch: 'acmeco.xyz', roles: ['publish'], actor: person('jane') }), 'role.not-member');
    await refused(() => grantRole(db, { orgId: org, userId: users['fred']!, branch: 'padi.xyz', roles: ['publish'], actor: person('jane') }), 'role.outside-organization');
    await refused(() => grantRole(db, { orgId: org, userId: users['fred']!, branch: 'acmeco.xyz', roles: [], actor: person('jane') }), 'role.none');
    await refused(() => grantRole(db, { orgId: org, userId: users['fred']!, branch: 'Acmeco', roles: ['publish'], actor: person('jane') }), 'role.bad-branch');
  });

  test('a non-admin can neither grant nor add', async () => {
    await refused(() => grantRole(db, { orgId: org, userId: users['fred']!, branch: 'acmeco.xyz.temp', reach: 'name', roles: ['admin'], actor: person('fred') }), 'role.not-admin');
    await refused(() => addMember(db, { orgId: org, userId: users['stranger']!, actor: person('fred') }), 'role.not-admin');
  });

  test('a re-grant replaces what was held there, and the old row stays as history', async () => {
    await grantRole(db, { orgId: org, userId: users['fred']!, branch: 'acmeco.xyz.temp', reach: 'name', roles: ['publish'], actor: person('xavier') });
    const live = (await liveRolesOfUser(db, users['fred']!)).filter((r) => r.branch === 'acmeco.xyz.temp');
    assert.equal(live.length, 1);
    assert.deepEqual(live[0]!.roles, ['publish']);
    const all = await db.query(`SELECT 1 FROM role_grant WHERE user_id = $1 AND branch = 'acmeco.xyz.temp'`, [users['fred']]);
    assert.equal(all.rows.length, 2);
  });

  test('the last admin over the whole organization cannot revoke themselves away', async () => {
    const jane = (await liveRolesOfUser(db, users['jane']!))[0]!;
    await refused(() => revokeRole(db, { orgId: org, roleId: jane.id, actor: person('jane') }), 'role.last-admin');
    await refused(() => grantRole(db, { orgId: org, userId: users['jane']!, branch: '*', roles: ['register'], actor: person('jane') }), 'role.last-admin');
  });

  test('removing a member takes every role with it — and only a whole-organization admin may', async () => {
    await refused(() => removeMember(db, { orgId: org, userId: users['fred']!, actor: person('xavier') }), 'role.not-admin');
    const out = await removeMember(db, { orgId: org, userId: users['fred']!, actor: person('jane') });
    assert.deepEqual(out, { removed: true, revoked: 1 });
    assert.deepEqual(await liveRolesOfUser(db, users['fred']!), []);
  });

  test('every act is on the audit chain, and none is in the public journal', async () => {
    const acts = await db.query<{ action: string }>(`SELECT action FROM audit_event WHERE org_id = $1 ORDER BY seq`, [org]);
    const actions = new Set(acts.rows.map((r) => r.action));
    for (const a of ['member.add', 'role.grant', 'member.remove']) assert.ok(actions.has(a), a);
    const { isPublicAction } = await import('../src/distribution/journal.ts');
    for (const a of ['member.add', 'member.remove', 'role.grant', 'role.revoke']) assert.equal(isPublicAction(a), false, a);
  });
});

// --- The backfill -------------------------------------------------------------------

describe('migration 14 leaves everyone exactly the authority they had', () => {
  let h: Harness;

  before(async () => {
    h = await freshDatabase();
  });
  after(async () => {
    await h.close();
  });

  test('authors get register+publish on *, admins admin besides — and both can still act', async () => {
    const { runner } = await import('node-pg-migrate');
    const migrate = (direction: 'up' | 'down') =>
      runner({ databaseUrl: h.connectionString, dir: MIGRATIONS_DIR, direction, count: 1, migrationsTable: 'pgmigrations', log: () => {}, noLock: true });

    // Back to the world before roles, with two members in it.
    await migrate('down');
    const c = await h.pool.connect();
    let orgId: string;
    const ids: Record<string, string> = {};
    try {
      orgId = (await applySeed(c)).orgId;
      for (const [key, role] of [['author', 'author'], ['admin', 'admin']] as const) {
        const u = await c.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ($1, $2) RETURNING id`, [`oidc|bf-${key}`, `${key}@bf.test`]);
        ids[key] = u.rows[0]!.id;
        await c.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, ids[key], role]);
      }
    } finally {
      c.release();
    }
    await h.pool.end();
    Object.assign(h.pool, { end: async () => {} }); // ended here; the harness must not end it twice
    await migrate('up');

    const pool = new (await import('pg')).default.Pool({ connectionString: h.connectionString, max: 1 });
    try {
      const roles = await pool.query<{ user_id: string; branch: string; roles: string[] }>(`SELECT user_id, branch, roles FROM role_grant`);
      const of = (id: string) => roles.rows.find((r) => r.user_id === id)!;
      assert.deepEqual({ ...of(ids['author']!), user_id: undefined }, { user_id: undefined, branch: '*', roles: ['register', 'publish'] });
      assert.deepEqual({ ...of(ids['admin']!), user_id: undefined }, { user_id: undefined, branch: '*', roles: ['admin', 'register', 'publish'] });
      const store = new PgOwnershipStore(pool);
      for (const key of ['author', 'admin']) {
        for (const intent of ['register', 'publish'] as const) {
          const d = await authorizes(store, { userId: ids[key]!, kind: 'human' }, 'padi.backfill.check', { intent });
          assert.equal(d.allowed, true, `${key} ${intent}: ${d.detail}`);
        }
      }
    } finally {
      await pool.end();
    }
  });
});
