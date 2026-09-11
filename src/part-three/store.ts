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
  /** Current stewardship fields (spec §6.6) — the selection surface is where current facts belong (§18). */
  header_owner?: string | null;
  header_website?: string | null;
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
  versions: VersionSummary[];
};

/**
 * A registered name and its published versions — which is everything the
 * Registry knows: unpublished content lives with its author (spec §7.3).
 *
 * The EXISTENCE of a registration is public — "a name long registered but
 * never published can be seen for what it is" — so this answers for a name
 * with zero versions too.
 */
export async function resolveName(db: Queryable, name: string): Promise<RegisteredName | null> {
  const { rows } = await db.query<{
    name: string;
    registered_at: Date;
    imported_from: string | null;
    discarded_at: Date | null;
  }>(
    `SELECT name, registered_at, imported_from, discarded_at
       FROM profile WHERE name = $1 AND discarded_at IS NULL`,
    [name],
  );

  const profile = rows[0];
  // A discarded name never published and has been released (spec §7.3); it is
  // not registered any more, and 404 is the truthful answer.
  if (!profile || profile.discarded_at) return null;

  const versions = await db.query<VersionSummary>(
    `SELECT version, status, published_at, content_hash, header_owner, header_website
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
 * The root index (§19.3 extended to the whole Registry): every allocated Top
 * Level Prefix, with the same discipline as the allocation page — STABLE PUBLIC
 * FACTS ONLY. `status`, `class`, `pending_claimant`, locks and disputes are
 * deliberately not selected; in-flight governance stays off the page. The
 * counts are simple facts about the public namespace: how many names are
 * registered beneath the Prefix, and how many published versions they carry.
 */
export type IndexEntry = {
  tlp: string;
  holder: string | null;
  grandfathered: boolean;
  names: number;
  published_versions: number;
  /** Names with at least one published version. */
  published_names: number;
  /** Registered names with NOTHING published — §7.3's "seen for what it is". */
  unpublished_names: number;
};

export async function resolveIndex(db: Queryable): Promise<IndexEntry[]> {
  const { rows } = await db.query<IndexEntry>(
    `SELECT a.tlp,
            o.name AS holder,
            a.grandfathered,
            coalesce(c.names, 0)::int AS names,
            coalesce(c.versions, 0)::int AS published_versions,
            coalesce(c.published_names, 0)::int AS published_names,
            coalesce(c.names - c.published_names, 0)::int AS unpublished_names
       FROM allocation a
       LEFT JOIN organization o ON o.id = a.org_id
       LEFT JOIN (
         SELECT split_part(p.name, '.', 1) AS tlp,
                count(DISTINCT p.id) AS names,
                count(v.id) AS versions,
                count(DISTINCT p.id) FILTER (WHERE v.id IS NOT NULL) AS published_names
           FROM profile p
           LEFT JOIN profile_version v ON v.profile_id = p.id
          WHERE p.discarded_at IS NULL
          GROUP BY 1
       ) c ON c.tlp = a.tlp
      ORDER BY a.tlp`,
  );
  return rows;
}

/**
 * The catalog (§19.3's search affordance, grown up): a page of registered
 * names, optionally filtered by a string prefix or a substring search over
 * names and published Headers.
 *
 * Two rules carry over intact. It reads `profile` and `profile_version` only —
 * governance never reaches it (§4.1 rule 1). And it is a TEXT SEARCH OVER
 * STRINGS, never a hierarchy: the prefix filter tests the segment boundary
 * (`padi.test` matches `padi.test.abc`, never `padi.tstat.basic`) but implies
 * no relationship between the names it returns (spec §7.7).
 *
 * The searchable Header text (Title, Description) comes from each name's
 * LATEST version — the search surface tracks the namespace as it stands, while
 * every version stays citable by reference.
 */
export type CatalogEntry = {
  name: string;
  registered_at: Date;
  title: string | null;
  versions: { version: number; status: 'published' | 'deprecated' }[];
};

export type CatalogQuery = {
  q?: string;
  prefix?: string;
  limit: number;
  offset: number;
};

export type CatalogResult = {
  total: number;
  entries: CatalogEntry[];
};

/** LIKE/ILIKE treat %, _ and \ specially; a search string is literal text. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function searchCatalog(db: Queryable, query: CatalogQuery): Promise<CatalogResult> {
  const prefix = query.prefix ?? null;
  const prefixLike = prefix === null ? null : `${escapeLike(prefix)}.%`;
  const needle = query.q ? `%${escapeLike(query.q)}%` : null;

  // The filter, once. Matched names, with the latest version's Header text.
  const from = `
    FROM profile p
    LEFT JOIN LATERAL (
      SELECT v.content #>> '{Header,Title}'       AS title,
             v.content #>> '{Header,Description}' AS description
        FROM profile_version v
       WHERE v.profile_id = p.id
       ORDER BY v.version DESC
       LIMIT 1
    ) latest ON true
    WHERE p.discarded_at IS NULL
      AND ($1::text IS NULL OR p.name = $1 OR p.name LIKE $2)
      AND ($3::text IS NULL
           OR p.name ILIKE $3
           OR coalesce(latest.title, '') ILIKE $3
           OR coalesce(latest.description, '') ILIKE $3)`;

  const counted = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total ${from}`,
    [prefix, prefixLike, needle],
  );
  const total = counted.rows[0]?.total ?? 0;

  const page = await db.query<{ name: string; registered_at: Date; title: string | null }>(
    `SELECT p.name, p.registered_at, latest.title ${from}
      ORDER BY p.name
      LIMIT $4 OFFSET $5`,
    [prefix, prefixLike, needle, query.limit, query.offset],
  );

  if (page.rows.length === 0) return { total, entries: [] };

  const versions = await db.query<{ name: string; version: number; status: 'published' | 'deprecated' }>(
    `SELECT p.name, v.version, v.status
       FROM profile_version v
       JOIN profile p ON p.id = v.profile_id
      WHERE p.name = ANY($1)
      ORDER BY p.name, v.version`,
    [page.rows.map((r) => r.name)],
  );

  const byName = new Map<string, { version: number; status: 'published' | 'deprecated' }[]>();
  for (const row of versions.rows) {
    const list = byName.get(row.name) ?? [];
    list.push({ version: row.version, status: row.status });
    byName.set(row.name, list);
  }

  return {
    total,
    entries: page.rows.map((r) => ({ ...r, versions: byName.get(r.name) ?? [] })),
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
