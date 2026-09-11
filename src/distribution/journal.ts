/**
 * The journal — design §20.1. Types and the pure verifier.
 *
 * The journal is the audit chain of §4.3 PROJECTED: every event appears, in
 * order, so the chain is contiguous, and a public act carries the exact
 * preimage of its `event_hash`. Anything that is not a public act appears as
 * a redacted link — checkable, not readable.
 *
 * Nothing in this file touches a database or a socket. It is the part an
 * instance, the standalone verifier and the tests all share, and it must stay
 * that way: the point of a verifier is that it is small enough to be read.
 */

import { contentHash } from '../profile/store.ts';
import { eventHash, hashSubject, type ChainPreimage } from '../audit.ts';

/** The wire contract's version (§21). Additive changes only; bump on anything else. */
export const JOURNAL_FORMAT = 1;

/** Acts published in full. Everything else is redacted (§20.1). */
export const PUBLIC_ACTIONS = [
  'profile.register',
  'profile.publish',
  'profile.deprecate',
  'profile.stewardship',
  'profile.discard',
  'allocation.create',
] as const;

export type PublicAction = (typeof PUBLIC_ACTIONS)[number];

export function isPublicAction(action: string): action is PublicAction {
  return (PUBLIC_ACTIONS as readonly string[]).includes(action);
}

export type ChainHead = { seq: number; event_hash: string | null };

export type RedactedEntry = {
  seq: number;
  public: false;
  action: string;
  prev_event_hash: string | null;
  event_hash: string;
};

/** Stable public facts about an allocation — the §19.3 set, no more. */
export type AllocationFacts = {
  id: string;
  tlp: string;
  holder: string;
  org_id: string;
  grandfathered: boolean;
};

export type PublicEntry = ChainPreimage & {
  seq: number;
  public: true;
  event_hash: string;
  /**
   * The `after` payload the act hashed into `after_hash`. `stored` means it
   * came from audit_event.after_payload (migration 7); `reconstructed` means
   * the event predates that column and the payload was rebuilt from the
   * immutable row it created, in the shape record() used at the time. Absent
   * when neither is possible (an early stewardship act, say).
   */
  subject?: unknown;
  subject_source?: 'stored' | 'reconstructed';
  /** profile.publish: the frozen document. contentHash(document) === subject.content_hash. */
  document?: unknown;

  // Courtesy fields — read from the current rows, NOT covered by the hash.
  ref?: { name: string; version?: number };
  allocation_id?: string;
  registered_at?: string;
  imported_from?: string | null;
  published_at?: string;
  status?: 'published' | 'deprecated';
  owner?: string | null;
  website?: string | null;
  grandfathered?: boolean;
  pub_date_approximate?: boolean;
  missing_header_fields?: string[];
  content_hash?: string;
  discarded_at?: string;
  allocation?: AllocationFacts;
};

export type JournalEntry = PublicEntry | RedactedEntry;

export type JournalPage = {
  journal_format: number;
  since: number;
  entries: JournalEntry[];
  /** The last seq served; pass as `since` to continue. */
  next: number;
  more: boolean;
  /** Present only when the page reached the head — a full page is immutable and carries no moving part. */
  head?: ChainHead;
};

export type SnapshotVersion = {
  id: string;
  name: string;
  version: number;
  status: 'published' | 'deprecated';
  published_at: string;
  content_hash: string;
  owner: string | null;
  website: string | null;
  grandfathered: boolean;
  pub_date_approximate: boolean;
  missing_header_fields: string[];
  document: unknown;
};

export type Snapshot = {
  journal_format: number;
  generated_at: string;
  head: ChainHead;
  allocations: AllocationFacts[];
  names: { id: string; name: string; registered_at: string; imported_from: string | null; allocation_id: string }[];
  versions: SnapshotVersion[];
};

export type VerificationFailure = {
  seq: number;
  reason:
    | 'not-contiguous'
    | 'link-broken'
    | 'event-hash-mismatch'
    | 'subject-hash-mismatch'
    | 'document-hash-mismatch'
    | 'malformed';
  detail: string;
};

/**
 * Verify a page against what the caller already holds.
 *
 * `expected` is the link the first entry must continue from: the cursor's
 * event_hash, or null before the genesis event. `undefined` means "unknown"
 * (the standalone verifier starting mid-chain) and only internal links are
 * checked. Returns the failures, all of them, and the head the page ends on.
 */
export function verifyPage(
  entries: JournalEntry[],
  expected: { seq: number; event_hash: string | null } | undefined,
): { failures: VerificationFailure[]; head: ChainHead | null } {
  const failures: VerificationFailure[] = [];
  let prevSeq = expected?.seq;
  let prevHash: string | null | undefined = expected?.event_hash;

  for (const entry of entries) {
    if (typeof entry.seq !== 'number' || typeof entry.event_hash !== 'string') {
      failures.push({ seq: Number(entry.seq), reason: 'malformed', detail: 'seq or event_hash missing' });
      continue;
    }
    if (prevSeq !== undefined && entry.seq !== prevSeq + 1) {
      failures.push({
        seq: entry.seq,
        reason: 'not-contiguous',
        detail: `expected seq ${prevSeq + 1}; the chain has a gap or a repeat`,
      });
    }
    if (prevHash !== undefined && (entry.prev_event_hash ?? null) !== prevHash) {
      failures.push({
        seq: entry.seq,
        reason: 'link-broken',
        detail: `prev_event_hash ${entry.prev_event_hash ?? 'null'} does not continue from ${prevHash ?? 'null'}`,
      });
    }

    if (entry.public) {
      const computed = eventHash(entry);
      if (computed !== entry.event_hash) {
        failures.push({
          seq: entry.seq,
          reason: 'event-hash-mismatch',
          detail: `recomputed ${computed}, served ${entry.event_hash}`,
        });
      }
      if (entry.subject !== undefined) {
        const subjectHash = hashSubject(entry.subject);
        if (subjectHash !== entry.after_hash) {
          failures.push({
            seq: entry.seq,
            reason: 'subject-hash-mismatch',
            detail: `subject hashes to ${subjectHash}, after_hash is ${entry.after_hash}`,
          });
        }
      }
      if (entry.document !== undefined) {
        const claimed = subjectContentHash(entry) ?? entry.content_hash;
        const actual = contentHash(entry.document);
        if (claimed === undefined) {
          failures.push({ seq: entry.seq, reason: 'malformed', detail: 'a document with no content_hash to check it against' });
        } else if (claimed !== actual) {
          failures.push({
            seq: entry.seq,
            reason: 'document-hash-mismatch',
            detail: `document hashes to ${actual}, the act recorded ${claimed}`,
          });
        }
      }
    }

    prevSeq = entry.seq;
    prevHash = entry.event_hash;
  }

  const last = entries.at(-1);
  return { failures, head: last ? { seq: last.seq, event_hash: last.event_hash } : null };
}

/** The content_hash inside a publish entry's HASHED payload, if it has one. */
export function subjectContentHash(entry: PublicEntry): string | undefined {
  const subject = entry.subject as { content_hash?: unknown } | undefined;
  return typeof subject?.content_hash === 'string' ? subject.content_hash : undefined;
}

/** Every version in a snapshot must hash to what it claims. Returns the offenders. */
export function verifySnapshot(snapshot: Snapshot): { name: string; version: number; claimed: string; actual: string }[] {
  const bad: { name: string; version: number; claimed: string; actual: string }[] = [];
  for (const v of snapshot.versions) {
    const actual = contentHash(v.document);
    if (actual !== v.content_hash) bad.push({ name: v.name, version: v.version, claimed: v.content_hash, actual });
  }
  return bad;
}
