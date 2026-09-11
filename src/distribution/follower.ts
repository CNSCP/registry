/**
 * The follower — design §20.1. What turns a resolution server into a local
 * instance (spec §7.4).
 *
 * Two acts. BOOTSTRAP takes the snapshot and lays it down in one transaction,
 * recording the snapshot's head as the cursor. SYNC takes journal pages from
 * that cursor, and for each page: checks that it continues from the link the
 * instance holds, recomputes every event hash, checks every document against
 * the content hash its act recorded, applies the public acts, keeps a verbatim
 * copy of every entry, and advances the cursor — all in ONE transaction, so a
 * page that fails verification leaves the instance exactly where it was.
 *
 * Identifiers are the authoritative store's own. A version the journal names
 * by id is the same row here, which is what lets a deprecation or a
 * stewardship change land without a lookup that could land elsewhere.
 *
 * The follower never writes an audit_event: it is not a writer, and the
 * instance's own log stays empty (§20.5).
 */

import type pg from 'pg';
import { contentHash } from '../profile/store.ts';
import {
  JOURNAL_FORMAT,
  verifyPage,
  verifySnapshot,
  type JournalEntry,
  type JournalPage,
  type PublicEntry,
  type Snapshot,
} from './journal.ts';
import { instanceState } from './store.ts';

/** Enough of fetch() to be replaced by app.inject() in tests. */
export type Fetch = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export class FollowerError extends Error {
  readonly failures: unknown[];
  constructor(message: string, failures: unknown[] = []) {
    super(message);
    this.name = 'FollowerError';
    this.failures = failures;
  }
}

async function getJson<T>(fetch: Fetch, url: string): Promise<T> {
  const response = await fetch(url);
  if (response.status !== 200) throw new FollowerError(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

function servedBytes(document: unknown): Buffer {
  return Buffer.from(JSON.stringify(document), 'utf8');
}

/** Lay down a snapshot. Idempotent: an instance that already has state does nothing. */
export async function bootstrap(pool: pg.Pool, upstream: string, fetch: Fetch = globalThis.fetch): Promise<{ bootstrapped: boolean; head: Snapshot['head'] | null }> {
  const existing = await instanceState(pool);
  if (existing) return { bootstrapped: false, head: { seq: existing.cursor_seq, event_hash: existing.head_hash } };

  const snap = await getJson<Snapshot>(fetch, `${upstream}/distribution/snapshot`);
  if (snap.journal_format !== JOURNAL_FORMAT) {
    throw new FollowerError(`upstream speaks journal_format ${snap.journal_format}; this instance speaks ${JOURNAL_FORMAT}`);
  }
  const bad = verifySnapshot(snap);
  if (bad.length > 0) {
    throw new FollowerError(`${bad.length} version(s) in the snapshot do not hash to what they claim`, bad);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const a of snap.allocations) {
      await client.query(
        `INSERT INTO organization (id, name, status) VALUES ($1, $2, 'active') ON CONFLICT (id) DO NOTHING`,
        [a.org_id, a.holder],
      );
      await client.query(
        `INSERT INTO allocation (id, tlp, org_id, status, allocated_at, grandfathered)
         VALUES ($1, $2, $3, 'active', now(), $4) ON CONFLICT (id) DO NOTHING`,
        [a.id, a.tlp, a.org_id, a.grandfathered],
      );
    }
    for (const n of snap.names) {
      await client.query(
        `INSERT INTO profile (id, name, allocation_id, registered_at, imported_from)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [n.id, n.name, n.allocation_id, n.registered_at, n.imported_from],
      );
    }
    for (const v of snap.versions) {
      await client.query(
        `INSERT INTO profile_version
           (id, profile_id, version, content, served_bytes, content_hash, status, published_at,
            header_owner, header_website, grandfathered, pub_date_approximate, missing_header_fields)
         SELECT $1, p.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
           FROM profile p WHERE p.name = $2
         ON CONFLICT (id) DO NOTHING`,
        [
          v.id, v.name, v.version, JSON.stringify(v.document), servedBytes(v.document), v.content_hash,
          v.status, v.published_at, v.owner, v.website, v.grandfathered, v.pub_date_approximate,
          v.missing_header_fields,
        ],
      );
    }

    await client.query(
      `INSERT INTO instance_state (upstream, journal_format, cursor_seq, head_hash, upstream_head_seq, last_sync_at)
       VALUES ($1, $2, $3, $4, $3, now())`,
      [upstream, JOURNAL_FORMAT, snap.head.seq, snap.head.event_hash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { bootstrapped: true, head: snap.head };
}

export type SyncResult = { pages: number; applied: number; cursor: { seq: number; event_hash: string | null } };

/**
 * Follow the journal from the cursor to the head. One transaction per page.
 * A verification failure is recorded on instance_state and thrown; the cursor
 * does not move past it.
 */
export async function sync(pool: pg.Pool, fetch: Fetch = globalThis.fetch, limit = 200): Promise<SyncResult> {
  const state = await instanceState(pool);
  if (!state) throw new FollowerError('not bootstrapped: take the snapshot first');

  let cursor = { seq: state.cursor_seq, event_hash: state.head_hash };
  let pages = 0;
  let applied = 0;

  try {
    for (;;) {
      const page = await getJson<JournalPage>(fetch, `${state.upstream}/distribution/journal?since=${cursor.seq}&limit=${limit}`);
      if (page.journal_format !== JOURNAL_FORMAT) {
        throw new FollowerError(`upstream speaks journal_format ${page.journal_format}; this instance speaks ${JOURNAL_FORMAT}`);
      }
      if (page.entries.length === 0) {
        await pool.query(
          `UPDATE instance_state SET last_sync_at = now(), upstream_head_seq = coalesce($1, upstream_head_seq)`,
          [page.head?.seq ?? null],
        );
        break;
      }

      const { failures, head } = verifyPage(page.entries, cursor);
      if (failures.length > 0 || !head) {
        throw new FollowerError(`journal page after seq ${cursor.seq} failed verification (${failures.length} failure(s))`, failures);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const entry of page.entries) {
          if (entry.public) {
            await apply(client, entry);
            applied++;
          }
          await client.query(
            `INSERT INTO journal_entry (seq, event_hash, prev_event_hash, entry) VALUES ($1, $2, $3, $4)`,
            [entry.seq, entry.event_hash, entry.prev_event_hash, JSON.stringify(entry)],
          );
        }
        await client.query(
          `UPDATE instance_state
              SET cursor_seq = $1, head_hash = $2, last_sync_at = now(),
                  upstream_head_seq = coalesce($3, greatest(upstream_head_seq, $1)),
                  last_error = NULL, last_error_at = NULL`,
          [head.seq, head.event_hash, page.head?.seq ?? null],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      cursor = head;
      pages++;
      if (!page.more) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool
      .query(`UPDATE instance_state SET last_error = $1, last_error_at = now()`, [message])
      .catch(() => undefined);
    throw error;
  }

  return { pages, applied, cursor };
}

/** One public act, onto this instance's rows. Idempotent where the schema allows. */
async function apply(db: pg.PoolClient, entry: PublicEntry): Promise<void> {
  const subject = (entry.subject ?? {}) as Record<string, unknown>;

  switch (entry.action) {
    case 'profile.register': {
      const name = entry.ref?.name ?? (subject['name'] as string | undefined);
      const allocationId = entry.allocation_id ?? (subject['allocation_id'] as string | undefined);
      const registeredAt = (subject['registered_at'] as string | undefined) ?? entry.registered_at;
      if (!name || !allocationId) throw new FollowerError(`seq ${entry.seq}: a registration with no name or allocation`);
      await db.query(
        `INSERT INTO profile (id, name, allocation_id, registered_at, imported_from)
         VALUES ($1, $2, $3, coalesce($4::timestamptz, now()), $5) ON CONFLICT (id) DO NOTHING`,
        [entry.subject_id, name, allocationId, registeredAt ?? null, entry.imported_from ?? null],
      );
      return;
    }

    case 'profile.publish': {
      const name = entry.ref?.name ?? (subject['name'] as string | undefined);
      const version = entry.ref?.version ?? (subject['version'] as number | undefined);
      const hash = (subject['content_hash'] as string | undefined) ?? entry.content_hash;
      if (!name || version === undefined || !hash || entry.document === undefined) {
        throw new FollowerError(`seq ${entry.seq}: a publication missing its name, version, hash or document`);
      }
      if (contentHash(entry.document) !== hash) {
        throw new FollowerError(`seq ${entry.seq}: ${name}:${version} does not hash to ${hash}`);
      }
      const publishedAt = (subject['published_at'] as string | undefined) ?? entry.published_at ?? null;
      const { rowCount } = await db.query(
        `INSERT INTO profile_version
           (id, profile_id, version, content, served_bytes, content_hash, status, published_at,
            header_owner, header_website, grandfathered, pub_date_approximate, missing_header_fields)
         SELECT $1, p.id, $3, $4, $5, $6, 'published', coalesce($7::timestamptz, now()),
                $8, $9, $10, $11, $12
           FROM profile p WHERE p.name = $2
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.subject_id, name, version, JSON.stringify(entry.document), servedBytes(entry.document), hash,
          publishedAt, entry.owner ?? null, entry.website ?? null,
          (subject['grandfathered'] as boolean | undefined) ?? entry.grandfathered ?? false,
          (subject['pub_date_approximate'] as boolean | undefined) ?? entry.pub_date_approximate ?? false,
          (subject['missing_header_fields'] as string[] | undefined) ?? entry.missing_header_fields ?? [],
        ],
      );
      // A publication for a name this instance does not hold is a break in
      // the story, not something to skip.
      if (rowCount === 0) {
        const held = await db.query(`SELECT 1 FROM profile_version WHERE id = $1`, [entry.subject_id]);
        if (held.rowCount === 0) throw new FollowerError(`seq ${entry.seq}: "${name}" is not registered here; cannot place version ${version}`);
      }
      return;
    }

    case 'profile.deprecate':
      await db.query(`UPDATE profile_version SET status = 'deprecated' WHERE id = $1 AND status = 'published'`, [entry.subject_id]);
      return;

    case 'profile.stewardship': {
      const owner = (subject['header_owner'] as string | null | undefined) ?? entry.owner ?? null;
      const website = (subject['header_website'] as string | null | undefined) ?? entry.website ?? null;
      await db.query(`UPDATE profile_version SET header_owner = $2, header_website = $3 WHERE id = $1`, [entry.subject_id, owner, website]);
      return;
    }

    case 'profile.discard': {
      const at = (subject['discarded_at'] as string | undefined) ?? entry.discarded_at ?? null;
      await db.query(
        `UPDATE profile SET discarded_at = coalesce($2::timestamptz, now()) WHERE name = $1 AND discarded_at IS NULL`,
        [entry.subject_id, at],
      );
      return;
    }

    case 'allocation.create': {
      const facts = entry.allocation;
      const tlp = facts?.tlp ?? (subject['tlp'] as string | undefined);
      const holder = facts?.holder ?? (subject['holder'] as string | undefined);
      const orgId = facts?.org_id ?? entry.org_id;
      if (!tlp || !holder || !orgId) throw new FollowerError(`seq ${entry.seq}: an allocation with no tlp, holder or organization`);
      await db.query(`INSERT INTO organization (id, name, status) VALUES ($1, $2, 'active') ON CONFLICT (id) DO NOTHING`, [orgId, holder]);
      await db.query(
        `INSERT INTO allocation (id, tlp, org_id, status, allocated_at, grandfathered)
         VALUES ($1, $2, $3, 'active', now(), $4) ON CONFLICT (id) DO NOTHING`,
        [entry.subject_id, tlp, orgId, facts?.grandfathered ?? (subject['grandfathered'] as boolean | undefined) ?? false],
      );
      return;
    }
  }
}

/** For tests and tooling: is this entry one the follower would act on? */
export function isApplied(entry: JournalEntry): entry is PublicEntry {
  return entry.public;
}
