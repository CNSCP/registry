/**
 * §4.1 rule 2 — the seam is the ONLY synchronous coupling, and Part Two "must
 * remain able to serve reads and edits when Part One is unavailable; only
 * registration and publication block."
 *
 * Registration and publication genuinely need the seam: spec §7.3 requires the
 * owner's authorization to exist for those acts, and only Part One can answer.
 * But an author already shaping a Draft must not lose their workspace because
 * the allocation service is down.
 *
 * The fallback needs something local to check, and this column is it: the
 * app_user that registered the name — an answer the seam gave at registration,
 * recorded durably on the row it authorized. During an outage, edit-class acts
 * (Draft writes, deprecation, stewardship, disclosure, discard) are served for
 * the registrant; everyone else waits with the seam. In normal operation the
 * seam is consulted as always, so this widens nothing while Part One is up.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumn('profile', {
    registered_by: {
      type: 'uuid',
      references: 'app_user',
      comment:
        'The app_user whose authorization the seam confirmed at registration. The local fallback for edit-class acts during a Part One outage (§4.1 rule 2).',
    },
  });
}

export async function down(pgm) {
  pgm.dropColumn('profile', 'registered_by');
}
