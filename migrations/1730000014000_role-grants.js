/**
 * 9 October 2026 — design §6.2, §25 Q7(a).
 *
 * Membership stops being authority. What a member may do is a ROLE ON A
 * BRANCH: `register`, `publish` and `admin`, in any combination, on a branch
 * of the namespace (`acme.xyz` — that name and everything beneath it, on
 * whole segments), on a single name (`reach = 'name'`), or on `*`, everything
 * the organization may act on, now and later.
 *
 * A role is revoked, never deleted: who could act where is history worth
 * keeping. At most one LIVE row per (organization, user, branch, reach); a
 * re-grant revokes the old row and writes a new one.
 *
 * BACKFILL, so nothing changes on the day: every existing member gets a role
 * on `*` — authors `register`+`publish`, admins `admin`+`register`+`publish`.
 * Every act that was authorized before this migration is authorized after it.
 *
 * `member.role` stays for now and nothing in the seam reads it; a later
 * migration drops it once no code does.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createType('role_reach', ['branch', 'name']);

  pgm.createTable('role_grant', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'organization', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'app_user', onDelete: 'CASCADE' },
    branch: { type: 'text', notNull: true, comment: "A name or Prefix, or '*' for everything the organization may act on." },
    reach: { type: 'role_reach', notNull: true, default: 'branch' },
    roles: { type: 'text[]', notNull: true },
    granted_by: { type: 'text', notNull: true, comment: 'The person (or operator principal) who granted it.' },
    granted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_by: { type: 'text' },
    revoked_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('role_grant', 'role_grant_roles_known', {
    check: "cardinality(roles) > 0 AND roles <@ ARRAY['register','publish','admin']::text[]",
  });
  pgm.addConstraint('role_grant', 'role_grant_star_is_a_branch', {
    check: "branch <> '*' OR reach = 'branch'",
  });
  pgm.addConstraint('role_grant', 'role_grant_revocation_whole', {
    check: '(revoked_at IS NULL) = (revoked_by IS NULL)',
  });
  pgm.createIndex('role_grant', ['org_id', 'user_id', 'branch', 'reach'], {
    unique: true,
    where: 'revoked_at IS NULL',
    name: 'role_grant_one_live',
  });
  pgm.createIndex('role_grant', 'user_id');

  pgm.sql(`
    INSERT INTO role_grant (org_id, user_id, branch, reach, roles, granted_by)
    SELECT org_id, user_id, '*', 'branch',
           CASE role WHEN 'admin' THEN ARRAY['admin','register','publish']
                     ELSE ARRAY['register','publish'] END,
           'migration 14 (backfill: membership as it stood)'
      FROM member
  `);
}

export async function down(pgm) {
  pgm.dropTable('role_grant');
  pgm.dropType('role_reach');
}
