/**
 * Workspace migration 2 — local registrations under `test` (design §20.3,
 * "`test.*` names on a workspace host"; spec §7.1).
 *
 * A `test.*` name on a workspace host has a lifecycle of its own: registered
 * here, saved as often as the author likes, resolved at its bare name to the
 * working document, released. It is never allocated, never published, never
 * relayed upstream and never in the feed. This table is the registration —
 * the workspace's own row, in the workspace's own migration set, so canon's
 * schema never gains it and the mirror never sees it.
 *
 * Forms saved under `test.*` before this migration (when saving needed no
 * registration) are carried over as registered, so none of them goes dark.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createTable('workspace_test_name', {
    name: {
      type: 'text',
      primaryKey: true,
      comment: 'A test.* name registered on this host only (spec §7.1); confers nothing anywhere else',
    },
    registered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    registered_by: {
      type: 'text',
      notNull: true,
      comment: 'The workspace credential\'s label and principal, as for a saved form',
    },
  });
  pgm.sql(`
    INSERT INTO workspace_test_name (name, registered_at, registered_by)
    SELECT name, updated_at, updated_by FROM workspace_profile WHERE name LIKE 'test.%'
    ON CONFLICT (name) DO NOTHING
  `);
}

export async function down(pgm) {
  pgm.dropTable('workspace_test_name');
}
