/**
 * Reading and writing anchors and the keys that sign them — design §20.2.
 *
 * Kept apart from `anchor.ts` (which is pure and has no database handle) so
 * the cryptography can be tested without a Postgres and the storage without a
 * key pair.
 */

import type { Queryable } from '../db.ts';
import { ageSeconds, checkAnchor, type AnchorDocument, type AnchorKey, type AnchorVerdict } from './anchor.ts';

export async function keyList(db: Queryable): Promise<AnchorKey[]> {
  const { rows } = await db.query<{
    key_id: string;
    public_key: string;
    valid_from: Date;
    valid_to: Date | null;
    vouched_by: string | null;
    vouch_signature: string | null;
  }>(
    `SELECT key_id, public_key, valid_from, valid_to, vouched_by, vouch_signature
       FROM anchor_key ORDER BY valid_from, key_id`,
  );
  return rows.map((r) => ({
    key_id: r.key_id,
    public_key: r.public_key,
    valid_from: r.valid_from.toISOString(),
    valid_to: r.valid_to ? r.valid_to.toISOString() : null,
    vouched_by: r.vouched_by,
    vouch_signature: r.vouch_signature,
  }));
}

export async function addKey(db: Queryable, key: AnchorKey): Promise<void> {
  await db.query(
    `INSERT INTO anchor_key (key_id, public_key, valid_from, valid_to, vouched_by, vouch_signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key_id) DO UPDATE SET valid_to = EXCLUDED.valid_to`,
    [key.key_id, key.public_key, key.valid_from, key.valid_to, key.vouched_by, key.vouch_signature],
  );
}

/** The most recently signed anchor this host holds. */
export async function latestAnchor(db: Queryable): Promise<(AnchorDocument & { verdict: string | null }) | null> {
  const { rows } = await db.query<{
    head_seq: string;
    head_event_hash: string;
    at_text: string;
    key_id: string;
    signature: string;
    origin: string;
    verdict: string | null;
  }>(
    `SELECT head_seq::text, head_event_hash, at_text, key_id, signature, origin, verdict
       FROM anchor ORDER BY signed_at DESC, head_seq DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    journal_format: 1,
    origin: row.origin,
    head_seq: Number(row.head_seq),
    head_event_hash: row.head_event_hash,
    // Verbatim, never re-formatted: the signature covers these bytes.
    at: row.at_text,
    key_id: row.key_id,
    signature: row.signature,
    verdict: row.verdict,
  };
}

/**
 * Record an anchor. Refuses a second, DIFFERENT anchor for the same head under
 * the same key rather than storing it quietly: two signatures over the same
 * sequence with different heads is the contradiction the whole mechanism
 * exists to surface, and it must reach a person, not a table.
 */
export type RecordOutcome =
  | { recorded: true; already: boolean }
  | { recorded: false; code: 'contradiction'; message: string; held: string };

export async function recordAnchor(
  db: Queryable,
  document: AnchorDocument,
  verdict?: { state: string; detail?: unknown },
): Promise<RecordOutcome> {
  const { rows } = await db.query<{ head_event_hash: string }>(
    `SELECT head_event_hash FROM anchor WHERE head_seq = $1 AND key_id = $2`,
    [document.head_seq, document.key_id],
  );
  const existing = rows[0];
  if (existing) {
    if (existing.head_event_hash === document.head_event_hash) return { recorded: true, already: true };
    return {
      recorded: false,
      code: 'contradiction',
      message:
        `Key "${document.key_id}" has already signed sequence ${document.head_seq} with a DIFFERENT head. ` +
        `Two signatures over one sequence is a fork made visible (§20.2): do not discard either — this is the evidence.`,
      held: existing.head_event_hash,
    };
  }

  await db.query(
    `INSERT INTO anchor (head_seq, head_event_hash, signed_at, at_text, key_id, signature, origin, verdict, verdict_detail, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)`,
    [
      document.head_seq,
      document.head_event_hash,
      document.at,
      document.at,
      document.key_id,
      document.signature,
      document.origin,
      verdict?.state ?? null,
      verdict?.detail === undefined ? null : JSON.stringify(verdict.detail),
    ],
  );
  return { recorded: true, already: false };
}

/**
 * An instance's side: check an anchor against what it verified for itself,
 * record the verdict, and hand the verdict back. Never throws on divergence —
 * the caller decides what to do, and the follower stops advancing.
 */
export async function receiveAnchor(
  db: Queryable,
  document: AnchorDocument,
  options: { rootKeyId: string; expectOrigin?: string; now?: Date },
): Promise<AnchorVerdict> {
  const keys = await keyList(db);
  const verdict = await checkAnchor(db, document, keys, options);
  await recordAnchor(db, document, { state: verdict.state, detail: verdict });
  return verdict;
}

export function anchorForStatus(
  document: (AnchorDocument & { verdict?: string | null }) | null,
  now = new Date(),
): Record<string, unknown> | null {
  if (!document) return null;
  const { verdict, ...rest } = document;
  return {
    ...rest,
    age_seconds: ageSeconds(document, now),
    ...(verdict ? { verified: verdict } : {}),
  };
}
