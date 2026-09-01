/**
 * Content negotiation and caching for resolution — design §18, §19.2.
 *
 * THE CACHING SPLIT IS THE SUBTLE PART (§18). Spec §7.4 says a cached version
 * "can never be stale in any way that affects a match". That holds for the
 * Properties, which never change. It does NOT hold for the whole document: the
 * Header's Status is lifecycle state, and Deprecation is a post-publication
 * change that *does* affect selection at Match.
 *
 * The split this module implements:
 *
 *   GET /<name>:<n>   the CONTRACT. Properties and fixed Header fields never
 *                     change, so `immutable, max-age=1y`. Its Status is a
 *                     snapshot taken at publication and MAY go stale — which is
 *                     safe only because Match does not read it (see below).
 *
 *   GET /<name>       the SELECTION SURFACE. This is what §17 has a Governor
 *                     read at Match: which versions exist and which are
 *                     Deprecated. Never immutable; always revalidated.
 *
 * That division is what makes the scheme sound. A Governor that selected on the
 * Status inside an immutably-cached versioned document would keep choosing a
 * version its author deprecated a year ago — the exact failure §18 warns about.
 * Deprecation reaches a local instance through the journal (§20) or through
 * revalidating the unversioned endpoint, never by a cache expiring.
 *
 * Drafts are never cacheable at all: a Draft may change at any time and a Realm
 * binding against one "holds nothing it may rely on between resolutions"
 * (spec §7.4).
 */

export const MEDIA = {
  /** Default for machines; a wildcard Accept resolves here (§19.2, settled §25 Q2). */
  spec2026: 'application/cp+json; profile=2026',
  /** The deployed shape. The /profiles/ alias, and by explicit negotiation. */
  legacy: 'application/json',
  html: 'text/html; charset=utf-8',
} as const;

export type Representation = 'spec2026' | 'legacy' | 'html';

/**
 * Choose a representation from an Accept header.
 *
 * Deliberately simple and deliberately biased: anything that does not clearly
 * ask for HTML or for the legacy shape gets the 2026 shape, because §19.2 makes
 * that the default and a wildcard Accept must land there. Quality values are
 * honoured only far enough to let a browser's
 * `text/html,application/xhtml+xml;q=0.9,...;q=0.8` pick HTML.
 */
export function negotiate(accept: string | undefined, fallback: Representation = 'spec2026'): Representation {
  if (!accept || accept.trim() === '') return fallback;

  const entries = accept
    .split(',')
    .map((part) => {
      const [type, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      const profile = params.map((p) => p.trim()).find((p) => p.startsWith('profile='));
      return { type: (type ?? '').trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, profile };
    })
    .filter((e) => e.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of entries) {
    if (entry.type === 'text/html' || entry.type === 'application/xhtml+xml') return 'html';
    if (entry.type === 'application/cp+json') return 'spec2026';
    if (entry.type === 'application/json') return 'legacy';
    if (entry.type === '*/*' || entry.type === 'application/*') return fallback;
  }

  return fallback;
}

/** RFC 9530 Content-Digest, from the stored content hash. */
export function contentDigest(sha256Hex: string): string {
  return `sha-256=:${Buffer.from(sha256Hex, 'hex').toString('base64')}:`;
}

/** A strong ETag. One name and version is one content commitment (spec §9.3). */
export function versionETag(contentHash: string, representation: Representation): string {
  // The representation is part of the entity: the same contract serialized two
  // ways is two entities, and a cache keyed only on the hash would serve the
  // wrong one to a client that negotiated differently.
  return `"${contentHash}-${representation}"`;
}

export type CacheHeaders = Record<string, string>;

/** A published version: the contract content never changes (§18). */
export function immutableVersionHeaders(contentHash: string, representation: Representation): CacheHeaders {
  return {
    'cache-control': 'public, max-age=31536000, immutable',
    'etag': versionETag(contentHash, representation),
    'content-digest': contentDigest(contentHash),
    'vary': 'Accept',
  };
}

/**
 * The selection surface: revalidate every time.
 *
 * `no-cache` does not mean "do not store" — it means "store, but revalidate
 * before use", which is exactly right here. A Governor keeps its copy and is
 * told in one round trip whether a version has been deprecated since.
 */
export function selectionHeaders(etag: string): CacheHeaders {
  return { 'cache-control': 'no-cache', 'etag': etag, 'vary': 'Accept' };
}

/** A Draft carries no promise of any kind (spec §7.4). */
export function draftHeaders(): CacheHeaders {
  return { 'cache-control': 'no-store', 'vary': 'Accept' };
}

/** Does an If-None-Match header match? Handles the list form and `*`. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}
