/**
 * Migration 12 — the signed anchor (design §4.3, §20.2).
 *
 * Two tables, both additive, neither touched by any existing path:
 *
 *   anchor_key  the public keys an anchor may be signed by, and — for every
 *               key after the first — the predecessor's signature vouching
 *               for it. The Registry NEVER holds a private key: signing is
 *               the operator's act on the operator's own machine, and a key
 *               the Registry could use to sign is a key that could sign a
 *               forked head.
 *
 *   anchor      the anchors themselves. On the authoritative host these are
 *               the ones the operator published; on a local instance they are
 *               the ones fetched from upstream, with the verdict of checking
 *               them against the journal this instance verified for itself.
 *
 * The comparison an instance makes is against `journal_entry` (migration 7),
 * which already holds the event hash at every sequence it has followed — so
 * nothing new is needed to remember what it saw.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createTable('anchor_key', {
    key_id: { type: 'text', primaryKey: true, comment: 'e.g. cp-anchor-2026-09' },
    public_key: { type: 'text', notNull: true, comment: 'base64url of the raw 32-byte Ed25519 public key' },
    valid_from: { type: 'timestamptz', notNull: true },
    valid_to: { type: 'timestamptz', comment: 'null while current' },
    vouched_by: {
      type: 'text',
      references: 'anchor_key',
      comment: 'The key_id whose signature vouches for this one; null for the root, which is checked by eye against a published fingerprint',
    },
    vouch_signature: { type: 'text', comment: "base64url Ed25519 over this key's canonical form, by vouched_by" },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('anchor_key', 'anchor_key_vouch_complete', {
    check: '(vouched_by IS NULL AND vouch_signature IS NULL) OR (vouched_by IS NOT NULL AND vouch_signature IS NOT NULL)',
  });

  pgm.createTable('anchor', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    head_seq: { type: 'bigint', notNull: true },
    head_event_hash: { type: 'text', notNull: true },
    signed_at: { type: 'timestamptz', notNull: true, comment: "the anchor's own `at`, which is part of what was signed" },
    key_id: { type: 'text', notNull: true, references: 'anchor_key' },
    signature: { type: 'text', notNull: true },
    origin: { type: 'text', notNull: true },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Instance side only: what checking it said.
    verdict: { type: 'text', comment: 'ok · ahead · before-bootstrap · diverged · unverifiable (null on the authoritative host)' },
    verdict_detail: { type: 'jsonb' },
    checked_at: { type: 'timestamptz' },
  });

  // One anchor per (head, key): signing the same head twice with the same key
  // is a no-op, and signing it twice DIFFERENTLY is the contradiction the
  // whole mechanism exists to make visible — so it must not be quietly stored
  // twice under one identity.
  pgm.createIndex('anchor', ['head_seq', 'key_id'], { unique: true, name: 'anchor_one_per_head_and_key' });
  pgm.createIndex('anchor', ['signed_at'], { name: 'anchor_by_time' });
}

export async function down(pgm) {
  pgm.dropTable('anchor');
  pgm.dropTable('anchor_key');
}
