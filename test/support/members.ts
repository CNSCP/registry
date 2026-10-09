/**
 * A member with the roles migration 14 would have backfilled (§6.2): `*`,
 * register+publish for an author, admin besides for an admin. For tests that
 * need someone who can act, not tests about who may grant what.
 */
import type { Queryable } from '../../src/db.ts';

export async function asMember(db: Queryable, orgId: string, userId: string, role: 'author' | 'admin' = 'author'): Promise<void> {
  await db.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role]);
  // A test that deleted the membership row directly leaves its roles behind; close them first.
  await db.query(`UPDATE role_grant SET revoked_at = now(), revoked_by = 'test' WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [orgId, userId]);
  await db.query(
    `INSERT INTO role_grant (org_id, user_id, branch, reach, roles, granted_by) VALUES ($1, $2, '*', 'branch', $3, 'test')`,
    [orgId, userId, role === 'admin' ? ['admin', 'register', 'publish'] : ['register', 'publish']],
  );
}
