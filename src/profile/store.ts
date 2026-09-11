/**
 * Writing Profiles and versions — design §12, §13.4.
 *
 * Every function here takes a `Queryable` rather than reaching for a pool, so
 * the caller controls the transaction. That is not a style preference: §4.3
 * requires the audit event be written in the SAME transaction as the change it
 * records, and a function that opens its own connection cannot honour that.
 */

import { createHash } from 'node:crypto';
import type { Queryable } from '../db.ts';
import { record } from '../audit.ts';
import { assertName } from '../names.ts';
import type { ActorKind } from '../part-one/types.ts';
import type { Profile, ProfileVersion } from './model.ts';
import { serializeProfileVersion } from './spec2026.ts';

export type Actor = { actor: string; kind: ActorKind; principal?: string };

/**
 * The content hash of a version (§12.2).
 *
 * Taken over the 2026 serialization with sorted keys, so two parties holding
 * the same contract compute the same digest regardless of how either stored it.
 * Spec §9.3 requires that independent parties be able to detect whether the
 * copies they hold agree; this is that mechanism's input.
 */
export function contentHash(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

/**
 * The hash of a version's CONTRACT: the document minus the three Header
 * fields the specification lets differ between answers — Status, Owner,
 * Website (spec §6.2, §6.6, §9.3). Two answers for one name and version
 * must agree on this, whatever their stewardship fields say; it is what an
 * outside party compares (verify-cli), and what an instance's answer is
 * held to.
 */
export function contractHash(document: unknown): string {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return contentHash(document);
  const doc = document as Record<string, unknown>;
  const header = doc['Header'];
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return contentHash(document);
  const { Status: _s, Owner: _o, Website: _w, ...fixed } = header as Record<string, unknown>;
  return contentHash({ ...doc, Header: fixed });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export type RegisterOptions = {
  name: string;
  allocationId: string;
  registeredAt?: Date;
  importedFrom?: string;
  /**
   * The app_user whose authorization the seam confirmed. Recorded so
   * edit-class acts have a local fallback during a Part One outage
   * (§4.1 rule 2). The importer leaves it unset — no user registered those.
   */
  registeredBy?: string;
};

/**
 * Register a name.
 *
 * Does NOT call authorizes() — the caller does, and passes the allocation_id it
 * returned. Keeping the check at the boundary rather than in here means the
 * seam stays one query (§4.1) and this function cannot accidentally become a
 * second, divergent authorization path.
 */
export async function registerName(
  db: Queryable,
  actor: Actor,
  options: RegisterOptions,
): Promise<{ id: string; name: string }> {
  assertName(options.name);

  const { rows } = await db.query<{ id: string; name: string; registered_at: Date }>(
    // Registration claims the name and nothing else (spec §6.3, §7.3): the
    // Registry holds no unpublished content, so there is nothing more to store.
    `INSERT INTO profile (name, allocation_id, registered_at, imported_from, registered_by)
     VALUES (
       $1::text,
       $2::uuid,
       coalesce($3::timestamptz, now()),
       $4::text,
       $5::uuid
     )
     RETURNING id, name, registered_at`,
    [
      options.name,
      options.allocationId,
      options.registeredAt ?? null,
      options.importedFrom ?? null,
      options.registeredBy ?? null,
    ],
  );

  const profile = rows[0];
  if (!profile) throw new Error(`failed to register "${options.name}"`);

  await record(db, {
    actor: actor.actor,
    actor_kind: actor.kind,
    principal: actor.principal ?? null,
    action: 'profile.register',
    subject_type: 'profile',
    subject_id: profile.id,
    // registered_at is inside the hashed payload so the journal's "since
    // when" (spec §9.3) is a verified fact for every registration from
    // migration 7 on, not a courtesy read from the row (§20.1).
    after: {
      name: options.name,
      allocation_id: options.allocationId,
      registered_at: profile.registered_at.toISOString(),
    },
    rationale: options.importedFrom
      ? `Imported from cp.padi.io as "${options.importedFrom}" (§10.4).`
      : null,
  });

  return profile;
}

export type PublishOptions = {
  profileId: string;
  name: string;
  profile: Profile;
  content: ProfileVersion;
  publishedAt?: Date;
  grandfathered?: boolean;
  pubDateApproximate?: boolean;
  missingHeaderFields?: string[];
  rationale?: string;
};

/**
 * Publish a version (§13.4).
 *
 * The version number is assigned by `publish_version()` in the database, under
 * a row lock on the parent profile — spec §6.2 makes assignment the Registry's
 * job, and two concurrent publications of one Profile must not both read the
 * same max.
 *
 * CALL ON THE CLIENT OF AN OPEN TRANSACTION (like record(), and for the same
 * reason): the row lock taken below to stamp the document with its assigned
 * Version lives only as long as the transaction, and in autocommit it expires
 * before publish_version() runs — the identity assertion then aborts a
 * concurrent publish rather than freezing a document that misstates itself.
 */
export async function publishVersion(
  db: Queryable,
  actor: Actor,
  options: PublishOptions,
): Promise<{ versionId: string; version: number; contentHash: string }> {
  // THE FROZEN DOCUMENT CARRIES ITS OWN IDENTITY (spec §6.4): Version,
  // Pub Date and Status are the Registry's to assign, and they are assigned
  // INTO the document before it is hashed and stored — a copy of the contract
  // that leaves the Registry must still say which version it is. (Two early
  // versions were frozen without them — padi.test.claude-demo:1 and
  // padi.lighting:1 — which is how this comment earned its capitals.)
  //
  // The number must agree with what publish_version() assigns, so take the
  // same row lock FIRST: publish_version re-locks (a no-op inside this
  // transaction) and recomputes the same max+1. The assertion below turns
  // any future disagreement into a rollback rather than a lying document.
  await db.query(`SELECT 1 FROM profile WHERE id = $1 FOR UPDATE`, [options.profileId]);
  const { rows: maxRows } = await db.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM profile_version WHERE profile_id = $1`,
    [options.profileId],
  );
  const next = maxRows[0]!.next;
  const publishedAt = options.publishedAt ?? new Date();

  if (options.profile.version !== undefined && options.profile.version !== next) {
    throw new Error(
      `"${options.name}": the document carries Version ${options.profile.version} but the Registry would assign ${next} (spec §6.2: assignment is the Registry's)`,
    );
  }

  const stamped = {
    ...options.profile,
    version: options.profile.version ?? next,
    pubDate: options.profile.pubDate ?? publishedAt.toISOString(),
    status: options.profile.status ?? ('Published' as const),
  };

  // The document as it will be served, and the bytes stored verbatim beside it.
  const document = serializeProfileVersion({ ...stamped, versions: [options.content] }, 0);
  const servedBytes = Buffer.from(JSON.stringify(document), 'utf8');
  const hash = contentHash(document);

  const { rows } = await db.query<{ version_id: string; assigned_version: number }>(
    `SELECT * FROM publish_version($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      options.profileId,
      JSON.stringify(document),
      servedBytes,
      hash,
      options.profile.owner ?? null,
      options.profile.website ?? null,
      options.grandfathered ?? false,
      options.pubDateApproximate ?? false,
      options.missingHeaderFields ?? [],
      publishedAt,
    ],
  );

  const published = rows[0];
  if (!published) throw new Error(`failed to publish a version of "${options.name}"`);
  if (published.assigned_version !== stamped.version) {
    throw new Error(
      `"${options.name}": the frozen document says Version ${stamped.version} but the Registry assigned ${published.assigned_version} — refusing to publish a document that misstates its own identity`,
    );
  }

  await record(db, {
    actor: actor.actor,
    actor_kind: actor.kind,
    principal: actor.principal ?? null,
    action: 'profile.publish',
    subject_type: 'profile_version',
    subject_id: published.version_id,
    after: {
      name: options.name,
      version: published.assigned_version,
      content_hash: hash,
      status: 'published',
      published_at: publishedAt.toISOString(),
      grandfathered: options.grandfathered ?? false,
      pub_date_approximate: options.pubDateApproximate ?? false,
      missing_header_fields: options.missingHeaderFields ?? [],
    },
    rationale: options.rationale ?? null,
  });

  return {
    versionId: published.version_id,
    version: published.assigned_version,
    contentHash: hash,
  };
}

/** Spec §6.4 — the only Header change permitted after publication. */
export async function updateStewardship(
  db: Queryable,
  actor: Actor,
  versionId: string,
  fields: { owner?: string | null; website?: string | null },
): Promise<void> {
  const { rows } = await db.query<{ header_owner: string | null; header_website: string | null }>(
    `UPDATE profile_version
        SET header_owner   = coalesce($2, header_owner),
            header_website = coalesce($3, header_website)
      WHERE id = $1
      RETURNING header_owner, header_website`,
    [versionId, fields.owner ?? null, fields.website ?? null],
  );

  const updated = rows[0];
  if (!updated) throw new Error(`no version ${versionId}`);

  await record(db, {
    actor: actor.actor,
    actor_kind: actor.kind,
    principal: actor.principal ?? null,
    action: 'profile.stewardship',
    subject_type: 'profile_version',
    subject_id: versionId,
    after: updated,
    rationale: 'Owner and Website are the stewardship fields (spec §6.4).',
  });
}

/** Spec §6.2 — excluded from selection for new Connections; changes nothing else. */
export async function deprecateVersion(
  db: Queryable,
  actor: Actor,
  versionId: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE profile_version SET status = 'deprecated' WHERE id = $1 AND status = 'published'`,
    [versionId],
  );
  if (!rowCount) throw new Error(`no published version ${versionId}`);

  await record(db, {
    actor: actor.actor,
    actor_kind: actor.kind,
    principal: actor.principal ?? null,
    action: 'profile.deprecate',
    subject_type: 'profile_version',
    subject_id: versionId,
    after: { status: 'deprecated' },
    rationale: null,
  });
}
