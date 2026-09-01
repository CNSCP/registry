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

function canonical(value: unknown): string {
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

  const { rows } = await db.query<RecordedEvent>(
    `INSERT INTO audit_event
       (actor, actor_kind, principal, org_id, action, subject_type, subject_id,
        before_hash, after_hash, rationale, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
