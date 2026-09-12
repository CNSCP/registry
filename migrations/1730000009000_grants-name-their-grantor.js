/**
 * 12 September 2026 review — design §8.3, §8.4, §25 Q7(b).
 *
 * An authorization record now names the organization that made it. The seam
 * honours a grant only while `granted_by_org_id` is the allocation's CURRENT
 * holder, which enforces two rules with one comparison: a grant made by a
 * former holder lapses when the Prefix changes hands (revoked by default —
 * the new holder re-grants, or accepts by re-issuing), and a grantee cannot
 * grant onward, because a record it issues names itself, not the holder.
 *
 * NOT NULL without a default: no authorization record has been issued on any
 * database yet (the seed creates none, and no issuance path exists before
 * Phase 2), so there is nothing to backfill and nothing this can break.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumn('authorization_record', {
    granted_by_org_id: {
      type: 'uuid',
      notNull: true,
      references: 'organization',
      onDelete: 'RESTRICT',
      comment: 'The organization that made the grant. Effective only while it holds the allocation (§8.3, §8.4).',
    },
  });
  pgm.createIndex('authorization_record', 'granted_by_org_id');
}

export async function down(pgm) {
  pgm.dropColumn('authorization_record', 'granted_by_org_id');
}
