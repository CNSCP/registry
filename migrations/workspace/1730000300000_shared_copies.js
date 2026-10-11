/**
 * Workspace migration 3 — shared copies (design §20.3, "Sharing a form").
 *
 * A form on a workspace host is now one of two kinds:
 *   own     the author's working form, saved here under the workspace
 *           credential — every row before this migration;
 *   shared  a copy of someone else's form, admitted ONLY by import, pinned to
 *           the hash it arrived with and never edited here.
 *
 * Columns on the same table rather than a second table, so that "one form per
 * name per host" stays a primary key and not a promise: a host can never hold
 * its own form and a shared copy under one name at once.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumns('workspace_profile', {
    kind: {
      type: 'text',
      notNull: true,
      default: 'own',
      comment: "'own' (saved here) or 'shared' (imported; read-only here)",
    },
    origin: {
      type: 'text',
      comment: 'Shared copies: the host the form was first shared from, as an origin URL; NULL when it came as a bare document',
    },
    origin_verified: {
      type: 'boolean',
      comment: 'Shared copies: true when THIS host fetched it from the origin over TLS; false when the origin is only stated',
    },
    via: {
      type: 'text[]',
      notNull: true,
      default: '{}',
      comment: 'Shared copies: hosts it passed through after the origin, oldest first',
    },
    source_link: {
      type: 'text',
      comment: 'Shared copies imported by link: the link, for Check for update',
    },
    shared_at: {
      type: 'timestamptz',
      comment: 'Shared copies: when it was imported here',
    },
  });
  pgm.addConstraint('workspace_profile', 'workspace_profile_kind', {
    check: "kind IN ('own', 'shared') AND (kind = 'shared' OR (origin IS NULL AND source_link IS NULL AND shared_at IS NULL))",
  });
}

export async function down(pgm) {
  pgm.dropConstraint('workspace_profile', 'workspace_profile_kind');
  pgm.dropColumns('workspace_profile', ['kind', 'origin', 'origin_verified', 'via', 'source_link', 'shared_at']);
}
