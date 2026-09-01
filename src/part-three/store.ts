/**
 * The resolution read path — design §17, §19.
 *
 * §4.1 RULE 1: GOVERNANCE STATE MUST NEVER REACH THIS FILE.
 *
 * A suspended organization, a locked allocation, a dispute in flight — none of
 * it may affect resolution of published versions, which spec §9.3 answers "to
 * any party" regardless of what has become of an author. §4.1 calls this "easy
 * to violate accidentally with a naive join across the seam", and it is: one
 * `JOIN organization` added here for a plausible reason and the Registry is
 * non-conforming, silently, for the subset of names whose owners are in
 * trouble.
 *
 * So the queries below touch `profile` and `profile_version` and nothing else.
 * There is no join to `allocation`, `organization`, or `member` on any path
 * that serves a Profile. The single exception is the allocation page (§19.3),
 * which is ABOUT an allocation — and even there, only stable public facts are
 * selected, never `status`, never `pending_claimant`, never a dispute.
 */

import type { Queryable } from '../db.ts';

export type VersionSummary = {
  version: number;
  status: 'published' | 'deprecated';
  published_at: Date;
  content_hash: string;
};

export type ResolvedVersion = {
  name: string;
  version: number;
  status: 'published' | 'deprecated';
  published_at: Date;
  content: unknown;
  served_bytes: Buffer | null;
  content_hash: string;
  header_owner: string | null;
  header_website: string | null;
  grandfathered: boolean;
  pub_date_approximate: boolean;
  missing_header_fields: string[];
};

export type RegisteredName = {
  name: string;
  registered_at: Date;
  imported_from: string | null;
  draft_disclosure: 'private' | 'authorized' | 'public';
  versions: VersionSummary[];
};

/**
 * Everything about a registered name except its Draft content.
 *
 * Spec §7.3 makes the EXISTENCE of a registration public even where the content
 * is not — "a name long registered but never published can be seen for what it
 * is" — so this answers for a name with zero versions too.
 */
export async function resolveName(db: Queryable, name: string): Promise<RegisteredName | null> {
  const { rows } = await db.query<{
    name: string;
    registered_at: Date;
    imported_from: string | null;
    draft_disclosure: RegisteredName['draft_disclosure'];
    discarded_at: Date | null;
  }>(
    `SELECT name, registered_at, imported_from, draft_disclosure, discarded_at
       FROM profile WHERE name = $1`,
    [name],
  );

  const profile = rows[0];
  // A discarded name never published and has been released (spec §7.3); it is
  // not registered any more, and 404 is the truthful answer.
  if (!profile || profile.discarded_at) return null;

  const versions = await db.query<VersionSummary>(
    `SELECT version, status, published_at, content_hash
       FROM profile_version v
       JOIN profile p ON p.id = v.profile_id
      WHERE p.name = $1
      ORDER BY version`,
    [name],
  );

  return {
    name: profile.name,
    registered_at: profile.registered_at,
    imported_from: profile.imported_from,
    draft_disclosure: profile.draft_disclosure,
    versions: versions.rows,
  };
}

/** One published version. The citable, cacheable form (§19). */
export async function resolveVersion(
  db: Queryable,
  name: string,
  version: number,
): Promise<ResolvedVersion | null> {
  const { rows } = await db.query<ResolvedVersion>(
    `SELECT p.name,
            v.version, v.status, v.published_at, v.content, v.served_bytes,
            v.content_hash, v.header_owner, v.header_website,
            v.grandfathered, v.pub_date_approximate, v.missing_header_fields
       FROM profile_version v
       JOIN profile p ON p.id = v.profile_id
      WHERE p.name = $1 AND v.version = $2 AND p.discarded_at IS NULL`,
    [name, version],
  );
  return rows[0] ?? null;
}

/** Draft content. The caller decides entitlement (§13.3); this only fetches. */
export async function resolveDraft(
  db: Queryable,
  name: string,
): Promise<{ content: unknown; disclosure: RegisteredName['draft_disclosure']; modified: Date | null } | null> {
  const { rows } = await db.query<{
    draft_content: unknown;
    draft_disclosure: RegisteredName['draft_disclosure'];
    draft_modified: Date | null;
  }>(
    `SELECT draft_content, draft_disclosure, draft_modified
       FROM profile WHERE name = $1 AND discarded_at IS NULL`,
    [name],
  );
  const row = rows[0];
  if (!row || row.draft_content === null) return null;
  return { content: row.draft_content, disclosure: row.draft_disclosure, modified: row.draft_modified };
}

/**
 * The allocation page (§19.3).
 *
 * Stable public facts only. `allocation.status`, `pending_claimant`, locks,
 * redemption clocks and disputes are DELIBERATELY NOT SELECTED: §19.3 says
 * in-flight governance stays off the page because it is transient, potentially
 * prejudicial, and no business of anyone resolving a name.
 *
 * The holder's name is a stable public fact and is included; who may act under
 * the Prefix is not, and is not.
 */
export type AllocationPage = {
  tlp: string;
  holder: string | null;
  grandfathered: boolean;
  names: { name: string; registered_at: Date; versions: VersionSummary[] }[];
};

export async function resolveAllocation(db: Queryable, tlp: string): Promise<AllocationPage | null> {
  const { rows } = await db.query<{ tlp: string; holder: string | null; grandfathered: boolean }>(
    `SELECT a.tlp, o.name AS holder, a.grandfathered
       FROM allocation a
       LEFT JOIN organization o ON o.id = a.org_id
      WHERE a.tlp = $1`,
    [tlp],
  );
  const allocation = rows[0];
  if (!allocation) return null;

  // Names beneath the Prefix. String prefix, not a tree — spec §7.1 places no
  // structure below a Prefix, so this is a scan over names beginning "tlp.".
  const names = await db.query<{ name: string; registered_at: Date }>(
    `SELECT name, registered_at FROM profile
      WHERE name LIKE $1 || '.%' AND discarded_at IS NULL
      ORDER BY name`,
    [tlp],
  );

  const versions = await db.query<VersionSummary & { name: string }>(
    `SELECT p.name, v.version, v.status, v.published_at, v.content_hash
       FROM profile_version v
       JOIN profile p ON p.id = v.profile_id
      WHERE p.name LIKE $1 || '.%' AND p.discarded_at IS NULL
      ORDER BY p.name, v.version`,
    [tlp],
  );

  const byName = new Map<string, VersionSummary[]>();
  for (const row of versions.rows) {
    const list = byName.get(row.name) ?? [];
    list.push({
      version: row.version,
      status: row.status,
      published_at: row.published_at,
      content_hash: row.content_hash,
    });
    byName.set(row.name, list);
  }

  return {
    tlp: allocation.tlp,
    holder: allocation.holder,
    grandfathered: allocation.grandfathered,
    names: names.rows.map((n) => ({ ...n, versions: byName.get(n.name) ?? [] })),
  };
}

/**
 * Names beginning with a string — the SEARCH affordance of §19.3, and only that.
 *
 * `GET /acme.meter` when only `acme.meter.flow` exists is a 404 in the machine
 * representations, because `acme.meter` is not a registered name and the
 * specification places no structure below a Prefix. A helpful index that
 * behaved like a node would quietly reintroduce the name hierarchy CNS/CP does
 * not have. This exists so the HTML page can say "no such Profile — 3 names
 * begin `acme.meter.`" and be clearly framed as a search over strings.
 */
export async function namesBeginningWith(db: Queryable, prefix: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM profile
      WHERE name LIKE $1 || '.%' AND discarded_at IS NULL
      ORDER BY name LIMIT 50`,
    [prefix],
  );
  return rows.map((r) => r.name);
}
