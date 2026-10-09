/**
 * Roles on branches — design §6.2, §25 Q7(a), settled 9 October 2026.
 *
 * Membership is the precondition, not the permission. What a member may do is
 * a ROLE ON A BRANCH:
 *
 *   register   claim a name, and release one (possible only before anything
 *              is published under it, so release undoes a registration)
 *   publish    publish a version, deprecate one, change stewardship
 *   admin      grant and revoke roles within this branch, to members of the
 *              same organization; add members
 *
 * A branch is a name or Prefix covering itself and everything beneath it on
 * whole segments (`acme.xyz` covers `acme.xyz.temp`, never `acme.xyzzy`), or
 * — with `reach: 'name'` — exactly one name. `*` is everything the
 * organization may act on: every Prefix it holds and every §8.3 grant made to
 * it, now and later.
 *
 * An act needs three things at once (§6.2): membership, a role covering the
 * name, and a token carrying the matching scope. This module is the second;
 * the seam (`authorizes()`) checks the first two together, Part Two the third.
 */

import { record } from '../audit.ts';
import type { Queryable } from '../db.ts';
import { nameProblem, scopeCovers, tlpOf } from '../names.ts';

export const ROLES = ['register', 'publish', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type Reach = 'branch' | 'name';
export const EVERYTHING = '*';

export type RoleRow = {
  id: string;
  org_id: string;
  user_id: string;
  branch: string;
  reach: Reach;
  roles: Role[];
  granted_by: string;
  granted_at: Date;
};

/** Who is acting. An operator may act anywhere (repairs, first admins); a person acts as an admin or not at all. */
export type RoleActor =
  | { kind: 'operator'; principal: string }
  | { kind: 'human'; userId: string; email: string };

// --- Pure rules -------------------------------------------------------------

/** Does this role row reach this name? `*` is decided by the caller's path (the org may act here at all). */
export function roleCovers(row: Pick<RoleRow, 'branch' | 'reach'>, name: string): boolean {
  if (row.branch === EVERYTHING) return true;
  if (row.reach === 'name') return name === row.branch;
  return scopeCovers(row.branch, name);
}

/** May an admin holding `admin` on `adminRow` grant on `target`? Only within what they administer. */
export function administers(adminRow: Pick<RoleRow, 'branch' | 'reach'>, target: { branch: string; reach: Reach }): boolean {
  if (adminRow.branch === EVERYTHING) return true;
  if (target.branch === EVERYTHING) return false;
  if (adminRow.reach === 'name') return target.reach === 'name' && target.branch === adminRow.branch;
  return scopeCovers(adminRow.branch, target.branch);
}

/** `*`, a Prefix, or a name — never anything the grammar would refuse. Returns the problem, or null. */
export function branchProblem(branch: string): string | null {
  if (branch === EVERYTHING) return null;
  // A one-segment branch is a Prefix; nameProblem reports `single-segment`
  // before it looks at the characters, so check the segment as a name's.
  return nameProblem(branch.includes('.') ? branch : `${branch}.probe`);
}

export function parseRoles(input: string | string[]): Role[] {
  const list = (Array.isArray(input) ? input : input.split(',')).map((r) => r.trim()).filter(Boolean);
  const unknown = list.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (unknown.length > 0) throw new RoleError('role.unknown', `Unknown role${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The roles are ${ROLES.join(', ')}.`);
  return ROLES.filter((r) => list.includes(r));
}

export class RoleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// --- Reads ------------------------------------------------------------------

const COLUMNS = `id, org_id, user_id, branch, reach, roles, granted_by, granted_at`;

export async function liveRolesOfUser(db: Queryable, userId: string): Promise<RoleRow[]> {
  const { rows } = await db.query<RoleRow>(
    `SELECT ${COLUMNS} FROM role_grant WHERE user_id = $1 AND revoked_at IS NULL ORDER BY org_id, branch`,
    [userId],
  );
  return rows;
}

export async function liveRolesOfOrg(db: Queryable, orgId: string): Promise<RoleRow[]> {
  const { rows } = await db.query<RoleRow>(
    `SELECT ${COLUMNS} FROM role_grant WHERE org_id = $1 AND revoked_at IS NULL ORDER BY user_id, branch`,
    [orgId],
  );
  return rows;
}

async function isMember(db: Queryable, orgId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM member WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return rows.length > 0;
}

/** Can the organization act on this branch at all — a Prefix it holds, or inside a §8.3 grant made to it by the current holder? */
async function orgReaches(db: Queryable, orgId: string, branch: string): Promise<boolean> {
  if (branch === EVERYTHING) return true;
  const tlp = tlpOf(branch);
  const held = await db.query(`SELECT 1 FROM allocation WHERE tlp = $1 AND org_id = $2`, [tlp, orgId]);
  if (held.rows.length > 0) return true;
  const granted = await db.query<{ scope: string }>(
    `SELECT ar.scope FROM authorization_record ar JOIN allocation a ON a.id = ar.allocation_id
      WHERE a.tlp = $1 AND ar.grantee_org_id = $2 AND ar.status = 'active' AND ar.granted_by_org_id = a.org_id`,
    [tlp, orgId],
  );
  return granted.rows.some((g) => scopeCovers(g.scope, branch));
}

// --- Who may change roles ---------------------------------------------------

async function requireAdmin(
  db: Queryable,
  actor: RoleActor,
  orgId: string,
  target: { branch: string; reach: Reach } | 'whole-organization' | 'any',
): Promise<void> {
  if (actor.kind === 'operator') return;
  const mine = (await liveRolesOfUser(db, actor.userId)).filter((r) => r.org_id === orgId && r.roles.includes('admin'));
  const ok =
    target === 'any'
      ? mine.length > 0
      : target === 'whole-organization'
        ? mine.some((r) => r.branch === EVERYTHING)
        : mine.some((r) => administers(r, target));
  if (!ok) {
    const what =
      target === 'any' ? 'any part of this organization' : target === 'whole-organization' ? 'the whole organization (*)' : describe(target);
    throw new RoleError('role.not-admin', `${actor.email} is not an admin of ${what}.`);
  }
}

function describe(target: { branch: string; reach: Reach }): string {
  if (target.branch === EVERYTHING) return 'everything the organization may act on (*)';
  return target.reach === 'name' ? `the name ${target.branch}` : `the branch ${target.branch}`;
}

function actorFields(actor: RoleActor) {
  return actor.kind === 'operator'
    ? { actor: actor.principal, actor_kind: 'operator' as const, principal: actor.principal, by: actor.principal }
    : { actor: actor.userId, actor_kind: 'human' as const, by: actor.email };
}

/** After a change, an organization that had an admin on `*` must still have one. */
async function keepsAWholeAdmin(db: Queryable, orgId: string, hadOne: boolean): Promise<void> {
  if (!hadOne) return;
  const { rows } = await db.query(
    `SELECT 1 FROM role_grant WHERE org_id = $1 AND branch = '*' AND revoked_at IS NULL AND 'admin' = ANY(roles)`,
    [orgId],
  );
  if (rows.length === 0) {
    throw new RoleError('role.last-admin', 'That would leave the organization with no admin over the whole of it (*). Grant another first.');
  }
}

async function hasWholeAdmin(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM role_grant WHERE org_id = $1 AND branch = '*' AND revoked_at IS NULL AND 'admin' = ANY(roles)`,
    [orgId],
  );
  return rows.length > 0;
}

// --- Acts -------------------------------------------------------------------

export type GrantRequest = { orgId: string; userId: string; branch: string; reach?: Reach; roles: Role[]; actor: RoleActor };

/**
 * Grant roles on a branch. A re-grant on the same (user, branch, reach)
 * REPLACES the roles: the old row is revoked and a new one written, so the
 * history reads as what was held when. Run inside a transaction.
 */
export async function grantRole(db: Queryable, request: GrantRequest): Promise<RoleRow> {
  const reach: Reach = request.reach ?? 'branch';
  const branch = request.branch.trim();
  const problem = branchProblem(branch);
  if (problem) throw new RoleError('role.bad-branch', `"${branch}" is not a branch: ${problem}.`);
  if (branch === EVERYTHING && reach === 'name') throw new RoleError('role.bad-branch', '* is always a branch.');
  if (request.roles.length === 0) throw new RoleError('role.none', 'Grant at least one role; to take every role away, revoke.');
  if (!(await isMember(db, request.orgId, request.userId))) {
    throw new RoleError('role.not-member', 'Roles go only to members of the organization (§6.2). Add them as a member first.');
  }
  if (!(await orgReaches(db, request.orgId, branch))) {
    throw new RoleError('role.outside-organization', `The organization neither holds ${tlpOf(branch)} nor has a grant covering ${branch}.`);
  }
  await requireAdmin(db, request.actor, request.orgId, { branch, reach });

  const hadWhole = await hasWholeAdmin(db, request.orgId);
  const a = actorFields(request.actor);
  const previous = await db.query<RoleRow>(
    `UPDATE role_grant SET revoked_at = now(), revoked_by = $5
      WHERE org_id = $1 AND user_id = $2 AND branch = $3 AND reach = $4 AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
    [request.orgId, request.userId, branch, reach, a.by],
  );
  const { rows } = await db.query<RoleRow>(
    `INSERT INTO role_grant (org_id, user_id, branch, reach, roles, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [request.orgId, request.userId, branch, reach, request.roles, a.by],
  );
  const row = rows[0]!;
  await keepsAWholeAdmin(db, request.orgId, hadWhole);
  await record(db, {
    actor: a.actor,
    actor_kind: a.actor_kind,
    ...(a.actor_kind === 'operator' ? { principal: a.principal } : {}),
    org_id: request.orgId,
    action: 'role.grant',
    subject_type: 'role_grant',
    subject_id: row.id,
    ...(previous.rows[0] ? { before: { branch, reach, roles: previous.rows[0].roles } } : {}),
    after: { user_id: request.userId, branch, reach, roles: row.roles },
    rationale: `${a.by} granted ${row.roles.join('+')} on ${describe({ branch, reach })} (design §6.2).`,
  });
  return row;
}

export type RevokeRequest = { orgId: string; roleId: string; actor: RoleActor };

export async function revokeRole(db: Queryable, request: RevokeRequest): Promise<RoleRow> {
  const found = await db.query<RoleRow>(
    `SELECT ${COLUMNS} FROM role_grant WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
    [request.roleId, request.orgId],
  );
  const row = found.rows[0];
  if (!row) throw new RoleError('role.not-found', 'No live role with that id in this organization.');
  await requireAdmin(db, request.actor, request.orgId, { branch: row.branch, reach: row.reach });
  const hadWhole = await hasWholeAdmin(db, request.orgId);
  const a = actorFields(request.actor);
  await db.query(`UPDATE role_grant SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [row.id, a.by]);
  if (request.actor.kind !== 'operator') await keepsAWholeAdmin(db, request.orgId, hadWhole);
  await record(db, {
    actor: a.actor,
    actor_kind: a.actor_kind,
    ...(a.actor_kind === 'operator' ? { principal: a.principal } : {}),
    org_id: request.orgId,
    action: 'role.revoke',
    subject_type: 'role_grant',
    subject_id: row.id,
    before: { user_id: row.user_id, branch: row.branch, reach: row.reach, roles: row.roles },
    rationale: `${a.by} revoked ${row.roles.join('+')} on ${describe(row)} (design §6.2).`,
  });
  return row;
}

export type AddMemberRequest = { orgId: string; userId: string; actor: RoleActor };

/** Membership alone authorizes nothing; it is what roles are granted to. Any admin of the organization may add one. */
export async function addMember(db: Queryable, request: AddMemberRequest): Promise<{ added: boolean }> {
  await requireAdmin(db, request.actor, request.orgId, 'any');
  const { rowCount } = await db.query(
    `INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'author')
     ON CONFLICT ON CONSTRAINT member_unique_per_org DO NOTHING`,
    [request.orgId, request.userId],
  );
  if (!rowCount) return { added: false };
  const a = actorFields(request.actor);
  await record(db, {
    actor: a.actor,
    actor_kind: a.actor_kind,
    ...(a.actor_kind === 'operator' ? { principal: a.principal } : {}),
    org_id: request.orgId,
    action: 'member.add',
    subject_type: 'member',
    subject_id: request.userId,
    after: { org_id: request.orgId, user_id: request.userId },
    rationale: `Membership added by ${a.by}. It authorizes nothing until a role is granted (design §6.2).`,
  });
  return { added: true };
}

export type RemoveMemberRequest = { orgId: string; userId: string; actor: RoleActor };

/** Removing a member revokes every role they hold there. Needs an admin over the whole organization (`*`). */
export async function removeMember(db: Queryable, request: RemoveMemberRequest): Promise<{ removed: boolean; revoked: number }> {
  await requireAdmin(db, request.actor, request.orgId, 'whole-organization');
  if (!(await isMember(db, request.orgId, request.userId))) return { removed: false, revoked: 0 };
  const hadWhole = await hasWholeAdmin(db, request.orgId);
  const a = actorFields(request.actor);
  const revoked = await db.query(
    `UPDATE role_grant SET revoked_at = now(), revoked_by = $3
      WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [request.orgId, request.userId, a.by],
  );
  await db.query(`DELETE FROM member WHERE org_id = $1 AND user_id = $2`, [request.orgId, request.userId]);
  if (request.actor.kind !== 'operator') await keepsAWholeAdmin(db, request.orgId, hadWhole);
  await record(db, {
    actor: a.actor,
    actor_kind: a.actor_kind,
    ...(a.actor_kind === 'operator' ? { principal: a.principal } : {}),
    org_id: request.orgId,
    action: 'member.remove',
    subject_type: 'member',
    subject_id: request.userId,
    before: { org_id: request.orgId, user_id: request.userId, roles_revoked: revoked.rowCount ?? 0 },
    rationale: `Membership removed by ${a.by}, with every role it carried (design §6.2).`,
  });
  return { removed: true, revoked: revoked.rowCount ?? 0 };
}
