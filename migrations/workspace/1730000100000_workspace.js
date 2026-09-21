/**
 * Workspace migration 1 — the unpublished forms an instance holds beside its
 * mirror (design §20.3).
 *
 * This file lives in its own migration set, `migrations/workspace/`, applied
 * with `npm run migrate:workspace` and recorded in its own table
 * (`pgmigrations_workspace`) — NOT in the set the authoritative host runs.
 * Canon's schema never gains this table, so §12.1's enforcement stays
 * literally true there: the Registry cannot hold what it has nowhere to put.
 *
 * On an instance, the table is the workspace's and nothing else's. The
 * follower never writes it; the workspace never writes `profile` or
 * `profile_version`. There is no foreign key to `profile` on purpose: a
 * `test.*` form (spec §7.1) has no registration to point at, and a form whose
 * name was released goes dark by the organization rule and is swept, rather
 * than being cascaded away by the mirror's own housekeeping.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createTable('workspace_profile', {
    name: {
      type: 'text',
      primaryKey: true,
      comment: 'A registered name this workspace\'s organization holds, or a test.* name (spec §7.1); one form per name',
    },
    document: {
      type: 'jsonb',
      notNull: true,
      comment: 'The unpublished form as the author saved it, less the fields the Registry stamps (Version, Status, Pub Date)',
    },
    content_hash: {
      type: 'text',
      notNull: true,
      comment: 'contentHash(document); the ETag, and what If-Match compares',
    },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: {
      type: 'text',
      notNull: true,
      comment: 'The workspace credential\'s label and principal; drafts are not acts and this is their whole record',
    },
  });
  // No grammar constraint here: `nameProblem()` in src/names.ts is the one
  // definition of a well-formed name, and the store applies it before any row
  // is written. A second copy in SQL would be a second place for it to drift.
}

export async function down(pgm) {
  pgm.dropTable('workspace_profile');
}
