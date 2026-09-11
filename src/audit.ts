/**
 * Audit chain, application side — design §4.3.
 *
 * The chaining itself happens in the database (see the audit-chain migration),
 * so that no writer can append an unchained event even by bypassing this file.
 * What lives here is the calling convention: `record()` takes the client of an
 * open transaction, which makes it awkward to write an audit event OUTSIDE the
 * transaction that carries the change — and that awkwardness is the point.
 */

import { createHash } from 'node:crypto';
import type { Queryable } from './db.ts';
import type { ActorKind } from './part-one/types.ts';

export type AuditEvent = {
  actor: string;
  actor_kind: ActorKind;
  /** Required unless actor_kind is 'human'. The person behind a service or agent. */
  principal?: string | null;
  org_id?: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  before?: unknown;
  after?: unknown;
  rationale?: string | null;
  request_id?: string | null;
};

/**
 * SHA-256 over a stable serialisation of a subject.
 *
 * Key order must not change the hash, or two identical records would chain
 * differently depending on how they were built.
 */
export function hashSubject(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export type RecordedEvent = { seq: string; event_hash: string; prev_event_hash: string | null };

/** Append one event. Must be called on the client of the transaction carrying the change. */
export async function record(db: Queryable, event: AuditEvent): Promise<RecordedEvent> {
  if (event.actor_kind !== 'human' && !event.principal) {
    throw new Error(
      `audit: actor_kind "${event.actor_kind}" requires a principal — the human on whose behalf it acted (§4.3)`,
    );
  }

  // The payloads travel beside their hashes (migration 7). The chain commits
  // to them through before_hash/after_hash exactly as before; storing them is
  // what lets the journal (§20.1) publish the thing an independent party
  // recomputes the hash from, rather than only the hash.
  const { rows } = await db.query<RecordedEvent>(
    `INSERT INTO audit_event
       (actor, actor_kind, principal, org_id, action, subject_type, subject_id,
        before_hash, after_hash, rationale, request_id, before_payload, after_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING seq, event_hash, prev_event_hash`,
    [
      event.actor,
      event.actor_kind,
      event.principal ?? null,
      event.org_id ?? null,
      event.action,
      event.subject_type,
      event.subject_id,
      hashSubject(event.before),
      hashSubject(event.after),
      event.rationale ?? null,
      event.request_id ?? null,
      event.before === undefined || event.before === null ? null : JSON.stringify(event.before),
      event.after === undefined || event.after === null ? null : JSON.stringify(event.after),
    ],
  );

  const row = rows[0];
  if (!row) throw new Error('audit: insert returned no row');
  return row;
}

/** Current chain head, for anchor publication (§4.3). */
export async function head(db: Queryable): Promise<RecordedEvent | null> {
  const { rows } = await db.query<RecordedEvent>(
    `SELECT seq, event_hash, prev_event_hash FROM audit_event ORDER BY seq DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export type ChainBreak = {
  broken_at: string;
  /** What the hash should have been, recomputed from the row's own fields. */
  expected_hash: string | null;
  /** What the row actually carries. */
  stored_hash: string | null;
};

/** Verify the chain. Returns null if intact, or the first break. */
export async function verify(db: Queryable, fromSeq = 1): Promise<ChainBreak | null> {
  const { rows } = await db.query<ChainBreak>(`SELECT * FROM audit_chain_verify($1)`, [fromSeq]);
  return rows[0] ?? null;
}

/**
 * The chain function of the audit-chain migration, in TypeScript.
 *
 * `at` must already be the string the trigger formats —
 * `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')` — which is
 * why the journal (§20.1) serves `at` in exactly that form rather than as a
 * parsed timestamp: a verifier concatenates and hashes, and never formats.
 *
 * Exists so that a party holding only the journal — an instance, or the
 * standalone verifier — recomputes precisely what the database computed. If
 * the migration's preimage ever changes, this must change with it, and the
 * chain test that feeds real events through both will say so.
 */
export type ChainPreimage = {
  prev_event_hash: string | null;
  at: string;
  actor: string;
  actor_kind: string;
  principal: string | null;
  org_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  before_hash: string | null;
  after_hash: string | null;
  rationale: string | null;
  request_id: string | null;
};

/** `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.USOF')` — selected by the journal as the `at` string. */
export const AT_FORMAT_SQL = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')`;

export function eventHash(e: ChainPreimage): string {
  const payload = [
    e.prev_event_hash ?? '',
    e.at,
    e.actor,
    e.actor_kind,
    e.principal ?? '',
    e.org_id ?? '',
    e.action,
    e.subject_type,
    e.subject_id,
    e.before_hash ?? '',
    e.after_hash ?? '',
    e.rationale ?? '',
    e.request_id ?? '',
  ].join('\x1f');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
