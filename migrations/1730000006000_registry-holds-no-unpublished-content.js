/**
 * The 8 September 2026 spec revision — spec §6.3, §7.3, §9.3.
 *
 *   "The Registry holds and answers for published versions only. Of an
 *    unpublished name it holds the entry alone — the name and its
 *    registration date — and it SHALL NOT hold, serve, or answer for the
 *    content of an unpublished Profile. That content is the author's own."
 *
 * The 26 August draft had the Registry storing the Draft (renamed
 * "unpublished" in this revision) with three disclosure states and an
 * irreversible trapdoor to `public`. The revision moves all of that out of
 * the Registry: content reaches a Realm only as the author conveys it, and a
 * Realm that binds an unpublished Profile publishes what it took in — the
 * disclosure consequence now lives with Governors, not here.
 *
 * So this migration DROPS the draft columns and the trapdoor. Publication now
 * carries its content in the act itself (§7.3: "Publication is the act by
 * which a Profile's content enters the Registry"), and a registered,
 * never-published name is exactly what §9.4 says it is: "a registered name
 * whose content has not yet been checked", holding nothing.
 *
 * Any draft_content still in these columns is unpublished by definition —
 * content the Registry may not hold — so dropping it is the compliant act,
 * not a data loss. (On this database that is at most the two demo drafts from
 * the authoring walkthrough; real work was published, and published versions
 * are untouched.)
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS draft_disclosure_trapdoor_trigger ON profile;
    DROP FUNCTION IF EXISTS draft_disclosure_trapdoor();
  `);

  pgm.dropColumn('profile', 'draft_content');
  pgm.dropColumn('profile', 'draft_modified');
  pgm.dropColumn('profile', 'draft_disclosure');
  pgm.dropType('draft_disclosure');
}

export async function down(pgm) {
  // Recreating the columns is possible; recreating the dropped content is
  // not, and must not be — it was unpublished. The down path restores the
  // schema shape only, for migration symmetry.
  pgm.createType('draft_disclosure', ['private', 'authorized', 'public']);
  pgm.addColumn('profile', {
    draft_content: { type: 'jsonb' },
    draft_modified: { type: 'timestamptz' },
    draft_disclosure: { type: 'draft_disclosure', notNull: true, default: 'private' },
  });
}
