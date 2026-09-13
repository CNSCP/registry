/**
 * Distribution reads — design §20.1.
 *
 * Same discipline as part-three/store.ts: governance state never reaches
 * this file. The snapshot and the journal carry stable public facts about
 * allocations (§19.3) and nothing about status, claimants or disputes. The
 * one place governance is visible is the audit chain itself, and there it is
 * REDACTED: an event that is not a public act appears as its hashes alone.
 */

import type pg from 'pg';
import type { Queryable } from '../db.ts';
import { AT_FORMAT_SQL } from '../audit.ts';
import {
  JOURNAL_FORMAT,
  isPublicAction,
  type AllocationFacts,
  type ChainHead,
  type JournalEntry,
  type JournalPage,
  type PublicEntry,
  type Snapshot,
  type SnapshotVersion,
} from './journal.ts';

export type Role = 'authoritative' | 'instance';

/** The chain head: the audit log's on the authoritative store, the verified cursor on an instance. */
export async function chainHead(db: Queryable, role: Role): Promise<ChainHead> {
  if (role === 'instance') {
    const { rows } = await db.query<{ cursor_seq: string; head_hash: string | null }>(
      `SELECT cursor_seq::text AS cursor_seq, head_hash FROM instance_state`,
    );
    const state = rows[0];
    return state ? { seq: Number(state.cursor_seq), event_hash: state.head_hash } : { seq: 0, event_hash: null };
  }
  const { rows } = await db.query<{ seq: string; event_hash: string }>(
    // ORDER BY the column, not the text alias — "99" sorts above "170".
    `SELECT seq::text AS seq, event_hash FROM audit_event ORDER BY audit_event.seq DESC LIMIT 1`,
  );
  const head = rows[0];
  return head ? { seq: Number(head.seq), event_hash: head.event_hash } : { seq: 0, event_hash: null };
}

function documentOf(row: { content: unknown; served_bytes: Buffer | null }): unknown {
  // The served bytes are the contract as answered (§19.2); parse those, not
  // the jsonb, so the document an instance stores is the one the authoritative
  // host serves. jsonb reorders keys; the hash does not care, but §20.4 asks
  // for byte-identical answers, and this is where that starts.
  return row.served_bytes ? JSON.parse(row.served_bytes.toString('utf8')) : row.content;
}

/**
 * One consistent read of everything published. REPEATABLE READ so the head
 * and the rows belong to the same instant; an instance that bootstraps from
 * this and follows the journal from `head` misses nothing and repeats nothing.
 */
export async function snapshot(pool: pg.Pool, role: Role): Promise<Snapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const head = await chainHead(client, role);

    const allocations = await client.query<AllocationFacts>(
      `SELECT a.id::text AS id, a.tlp, o.name AS holder, a.org_id::text AS org_id, a.grandfathered
         FROM allocation a JOIN organization o ON o.id = a.org_id
        ORDER BY a.tlp`,
    );

    const names = await client.query<{
      id: string; name: string; registered_at: Date; imported_from: string | null; allocation_id: string;
    }>(
      `SELECT id::text AS id, name, registered_at, imported_from, allocation_id::text AS allocation_id
         FROM profile WHERE discarded_at IS NULL ORDER BY name`,
    );

    const versions = await client.query<{
      id: string; name: string; version: number; status: 'published' | 'deprecated'; published_at: Date;
      content_hash: string; owner: string | null; website: string | null; grandfathered: boolean;
      pub_date_approximate: boolean; missing_header_fields: string[]; content: unknown; served_bytes: Buffer | null;
    }>(
      `SELECT v.id::text AS id, p.name, v.version, v.status, v.published_at, v.content_hash,
              v.header_owner AS owner, v.header_website AS website, v.grandfathered,
              v.pub_date_approximate, v.missing_header_fields, v.content, v.served_bytes
         FROM profile_version v JOIN profile p ON p.id = v.profile_id
        WHERE p.discarded_at IS NULL
        ORDER BY p.name, v.version`,
    );
    await client.query('COMMIT');

    return {
      journal_format: JOURNAL_FORMAT,
      generated_at: new Date().toISOString(),
      head,
      allocations: allocations.rows,
      names: names.rows.map((n) => ({ ...n, registered_at: n.registered_at.toISOString() })),
      versions: versions.rows.map(
        (v): SnapshotVersion => ({
          id: v.id,
          name: v.name,
          version: v.version,
          status: v.status,
          published_at: v.published_at.toISOString(),
          content_hash: v.content_hash,
          owner: v.owner,
          website: v.website,
          grandfathered: v.grandfathered,
          pub_date_approximate: v.pub_date_approximate,
          missing_header_fields: v.missing_header_fields,
          document: documentOf(v),
        }),
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type JournalRow = {
  seq: string;
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
  prev_event_hash: string | null;
  event_hash: string;
  after_payload: unknown | null;
  p_name: string | null;
  p_registered_at: Date | null;
  p_allocation_id: string | null;
  p_imported_from: string | null;
  pd_discarded_at: Date | null;
  v_name: string | null;
  v_version: number | null;
  v_status: 'published' | 'deprecated' | null;
  v_published_at: Date | null;
  v_content: unknown;
  v_served_bytes: Buffer | null;
  v_content_hash: string | null;
  v_owner: string | null;
  v_website: string | null;
  v_grandfathered: boolean | null;
  v_pub_date_approximate: boolean | null;
  v_missing: string[] | null;
  a_id: string | null;
  a_tlp: string | null;
  a_holder: string | null;
  a_org_id: string | null;
  a_grandfathered: boolean | null;
};

/**
 * Events before migration 7 stored no payload. For the three acts whose
 * payload was a pure function of an immutable row, rebuild it in the shape
 * record() used at the time, so after_hash stays checkable all the way back.
 * Anything else is left absent rather than guessed.
 */
function reconstructSubject(row: JournalRow): unknown | undefined {
  switch (row.action) {
    case 'profile.register':
      if (row.p_name === null) return undefined;
      return { name: row.p_name, allocation_id: row.p_allocation_id };
    case 'profile.publish':
      if (row.v_name === null) return undefined;
      return {
        name: row.v_name,
        version: row.v_version,
        content_hash: row.v_content_hash,
        grandfathered: row.v_grandfathered,
        missing_header_fields: row.v_missing ?? [],
      };
    case 'profile.deprecate':
      return { status: 'deprecated' };
    default:
      return undefined;
  }
}

function toEntry(row: JournalRow): JournalEntry {
  const seq = Number(row.seq);
  if (!isPublicAction(row.action)) {
    return { seq, public: false, action: row.action, prev_event_hash: row.prev_event_hash, event_hash: row.event_hash };
  }

  const entry: PublicEntry = {
    seq,
    public: true,
    at: row.at,
    actor: row.actor,
    actor_kind: row.actor_kind,
    principal: row.principal,
    org_id: row.org_id,
    action: row.action,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    rationale: row.rationale,
    request_id: row.request_id,
    prev_event_hash: row.prev_event_hash,
    event_hash: row.event_hash,
  };

  if (row.after_payload !== null && row.after_payload !== undefined) {
    entry.subject = row.after_payload;
    entry.subject_source = 'stored';
  } else {
    const rebuilt = reconstructSubject(row);
    if (rebuilt !== undefined) {
      entry.subject = rebuilt;
      entry.subject_source = 'reconstructed';
    }
  }

  switch (row.action) {
    case 'profile.register':
      if (row.p_name !== null) {
        entry.ref = { name: row.p_name };
        entry.allocation_id = row.p_allocation_id ?? undefined;
        entry.registered_at = row.p_registered_at?.toISOString();
        entry.imported_from = row.p_imported_from;
      }
      break;
    case 'profile.discard':
      entry.ref = { name: row.subject_id };
      entry.discarded_at = row.pd_discarded_at?.toISOString();
      break;
    case 'profile.publish':
    case 'profile.deprecate':
    case 'profile.stewardship':
      if (row.v_name !== null && row.v_version !== null) {
        entry.ref = { name: row.v_name, version: row.v_version };
        entry.status = row.v_status ?? undefined;
        entry.owner = row.v_owner;
        entry.website = row.v_website;
        if (row.action === 'profile.publish') {
          entry.published_at = row.v_published_at?.toISOString();
          entry.content_hash = row.v_content_hash ?? undefined;
          entry.grandfathered = row.v_grandfathered ?? undefined;
          entry.pub_date_approximate = row.v_pub_date_approximate ?? undefined;
          entry.missing_header_fields = row.v_missing ?? undefined;
          entry.document = documentOf({ content: row.v_content, served_bytes: row.v_served_bytes });
        }
      }
      break;
    case 'allocation.create':
    case 'allocation.transfer':
      if (row.a_tlp !== null && row.a_id !== null) {
        entry.allocation = {
          id: row.a_id,
          tlp: row.a_tlp,
          holder: row.a_holder ?? '',
          org_id: row.a_org_id ?? '',
          grandfathered: row.a_grandfathered ?? false,
        };
      }
      break;
  }

  return entry;
}

/** A page of the journal from the authoritative store: the audit chain, projected. */
export async function journalFromAudit(db: Queryable, since: number, limit: number): Promise<JournalPage> {
  const { rows } = await db.query<JournalRow>(
    `SELECT e.seq::text AS seq, ${AT_FORMAT_SQL} AS at,
            e.actor, e.actor_kind::text AS actor_kind, e.principal, e.org_id::text AS org_id,
            e.action, e.subject_type, e.subject_id, e.before_hash, e.after_hash,
            e.rationale, e.request_id, e.prev_event_hash, e.event_hash, e.after_payload,
            p.name AS p_name, p.registered_at AS p_registered_at,
            p.allocation_id::text AS p_allocation_id, p.imported_from AS p_imported_from,
            pd.discarded_at AS pd_discarded_at,
            vp.name AS v_name, v.version AS v_version, v.status AS v_status, v.published_at AS v_published_at,
            v.content AS v_content, v.served_bytes AS v_served_bytes, v.content_hash AS v_content_hash,
            v.header_owner AS v_owner, v.header_website AS v_website, v.grandfathered AS v_grandfathered,
            v.pub_date_approximate AS v_pub_date_approximate, v.missing_header_fields AS v_missing,
            a.id::text AS a_id, a.tlp AS a_tlp, o.name AS a_holder, a.org_id::text AS a_org_id,
            a.grandfathered AS a_grandfathered
       FROM audit_event e
       LEFT JOIN profile p ON e.subject_type = 'profile' AND e.action <> 'profile.discard' AND p.id::text = e.subject_id
       LEFT JOIN LATERAL (
         SELECT discarded_at FROM profile
          WHERE e.action = 'profile.discard' AND name = e.subject_id
            AND discarded_at IS NOT NULL AND discarded_at <= e.at
          ORDER BY discarded_at DESC LIMIT 1
       ) pd ON true
       LEFT JOIN profile_version v ON e.subject_type = 'profile_version' AND v.id::text = e.subject_id
       LEFT JOIN profile vp ON vp.id = v.profile_id
       LEFT JOIN allocation a ON e.subject_type = 'allocation' AND a.id::text = e.subject_id
       LEFT JOIN organization o ON o.id = a.org_id
      WHERE e.seq > $1
      ORDER BY e.seq
      LIMIT $2`,
    [since, limit + 1],
  );

  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(toEntry);
  const last = entries.at(-1);
  const page: JournalPage = {
    journal_format: JOURNAL_FORMAT,
    since,
    entries,
    next: last ? last.seq : since,
    more,
  };
  if (!more) page.head = await chainHead(db, 'authoritative');
  return page;
}

/** A page of the journal from an instance: its verbatim copy of what it verified. */
export async function journalFromCopy(
  db: Queryable,
  since: number,
  limit: number,
): Promise<JournalPage | { error: 'before-earliest'; earliest_seq: number }> {
  const earliest = await db.query<{ seq: string }>(`SELECT min(seq)::text AS seq FROM journal_entry`);
  const earliestSeq = earliest.rows[0]?.seq ? Number(earliest.rows[0].seq) : null;
  const head = await chainHead(db, 'instance');

  // An instance that bootstrapped from a snapshot holds the journal only from
  // that snapshot's head onward; asking for earlier is a question for upstream.
  if (earliestSeq !== null && since < earliestSeq - 1) return { error: 'before-earliest', earliest_seq: earliestSeq - 1 };
  if (earliestSeq === null && since < head.seq) return { error: 'before-earliest', earliest_seq: head.seq };

  const { rows } = await db.query<{ entry: JournalEntry }>(
    `SELECT entry FROM journal_entry WHERE seq > $1 ORDER BY seq LIMIT $2`,
    [since, limit + 1],
  );
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map((r) => r.entry);
  const last = entries.at(-1);
  const page: JournalPage = { journal_format: JOURNAL_FORMAT, since, entries, next: last ? last.seq : since, more };
  if (!more) page.head = head;
  return page;
}

export type InstanceState = {
  upstream: string;
  journal_format: number;
  cursor_seq: number;
  head_hash: string | null;
  upstream_head_seq: number | null;
  bootstrapped_at: Date;
  last_sync_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
};

export async function instanceState(db: Queryable): Promise<InstanceState | null> {
  const { rows } = await db.query<Omit<InstanceState, 'cursor_seq' | 'upstream_head_seq'> & { cursor_seq: string; upstream_head_seq: string | null }>(
    `SELECT upstream, journal_format, cursor_seq::text AS cursor_seq, head_hash,
            upstream_head_seq::text AS upstream_head_seq, bootstrapped_at, last_sync_at, last_error, last_error_at
       FROM instance_state`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    cursor_seq: Number(row.cursor_seq),
    upstream_head_seq: row.upstream_head_seq === null ? null : Number(row.upstream_head_seq),
  };
}
