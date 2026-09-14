/**
 * Migration 13 — store the anchor's `at` exactly as it was signed.
 *
 * The anchor's signature covers a canonical string that includes `at`. Stored
 * in a timestamptz and re-serialized on the way out, `2026-09-14T16:07:30Z`
 * came back as `2026-09-14T16:07:30.000Z` — the same instant, different bytes,
 * and therefore a signature that verified at publication and failed as served.
 *
 * The rule this encodes: **what was signed is stored verbatim, and what is
 * served is what was signed.** `signed_at` stays for ordering and for
 * `age_seconds`; `at_text` is the authority for anything a verifier hashes.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumn('anchor', {
    at_text: { type: 'text', comment: 'the `at` field exactly as signed; the served value, byte for byte' },
  });
  // Existing rows predate the distinction; the ISO form of what we stored is
  // the best available reconstruction, and the test below fails for any row
  // where it is wrong.
  pgm.sql(`UPDATE anchor SET at_text = to_char(signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE at_text IS NULL`);
  pgm.alterColumn('anchor', 'at_text', { notNull: true });
}

export async function down(pgm) {
  pgm.dropColumn('anchor', 'at_text');
}
