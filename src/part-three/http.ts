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

import { createHash } from 'node:crypto';

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

/**
 * RFC 9530 Content-Digest, over THE BYTES IN THIS MESSAGE (§18, 28 Sept).
 *
 * Not the content hash. `content_hash` is `sha256(canonicalJson(document))`
 * with object keys sorted, while what goes on the wire is `served_bytes` in
 * the author's own key order, with the three mutable Header fields overlaid
 * when they have moved. Two serializations of one document, and RFC 9530
 * defines this header as a digest of the content of *this* message — so a
 * client that hashes what arrived and compares must find it equal, or it
 * concludes the response was damaged in transit.
 *
 * The canonical hash keeps its own places: the ETag, the journal, the anchor.
 * This header answers a different question — did these bytes arrive intact —
 * and so it legitimately differs between two answers for one version when a
 * mutable field has moved, and between two representations of one contract.
 */
export function contentDigest(body: string | Buffer): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

/** A strong ETag. One name and version is one content commitment (spec §9.3). */
export function versionETag(contentHash: string, representation: Representation): string {
  // The representation is part of the entity: the same contract serialized two
  // ways is two entities, and a cache keyed only on the hash would serve the
  // wrong one to a client that negotiated differently.
  return `"${contentHash}-${representation}"`;
}

export type CacheHeaders = Record<string, string>;

/**
 * The retirement of the 2022 representation (§19.2, 28 Sept).
 *
 * The readers of that shape are deployed SDKs, not people, so a deprecation
 * that lives only in a brief is not a deprecation. `Deprecation` (RFC 9745) is
 * a structured-field Date — an `@` and a Unix timestamp — and may be in the
 * future; `Sunset` (RFC 8594) is an HTTP-date and MUST NOT be earlier than it.
 *
 * Unset means unset: a host that has not been told the dates says nothing,
 * rather than inventing one. A date announced and then moved is worse than a
 * date announced late.
 */
export type LegacyRetirement = { deprecation: number; sunset?: Date; href?: string };

export function legacyRetirementFromEnv(env: NodeJS.ProcessEnv = process.env): LegacyRetirement | null {
  const raw = (env['LEGACY_DEPRECATION'] ?? '').trim().replace(/^@/, '');
  if (!raw) return null;
  const deprecation = Number(raw);
  if (!Number.isInteger(deprecation)) {
    throw new Error('LEGACY_DEPRECATION is a Unix timestamp in seconds (RFC 9745), optionally written "@<seconds>"');
  }

  const out: LegacyRetirement = { deprecation };

  const sunsetRaw = (env['LEGACY_SUNSET'] ?? '').trim();
  if (sunsetRaw) {
    const sunset = new Date(sunsetRaw);
    if (Number.isNaN(sunset.getTime())) throw new Error('LEGACY_SUNSET is a date this runtime can parse');
    if (sunset.getTime() / 1000 < deprecation) {
      throw new Error('LEGACY_SUNSET must not be earlier than LEGACY_DEPRECATION (RFC 9745 §2)');
    }
    out.sunset = sunset;
  }

  const href = (env['LEGACY_MIGRATION_URL'] ?? '').trim();
  if (href) out.href = href;
  return out;
}

/** The headers that mark an answer in the 2022 representation as going away. */
export function retirementHeaders(retirement: LegacyRetirement | null | undefined): CacheHeaders {
  if (!retirement) return {};
  return {
    'deprecation': `@${retirement.deprecation}`,
    ...(retirement.sunset ? { 'sunset': retirement.sunset.toUTCString() } : {}),
    ...(retirement.href ? { 'link': `<${retirement.href}>; rel="deprecation"; type="text/html"` } : {}),
  };
}

/**
 * A published version: the contract content never changes (§18).
 *
 * `body` is the serialized answer, and is omitted on a `304`, which carries
 * the validators but has no content to digest.
 */
export function immutableVersionHeaders(
  contentHash: string,
  representation: Representation,
  body?: string | Buffer,
): CacheHeaders {
  return {
    'cache-control': 'public, max-age=31536000, immutable',
    'etag': versionETag(contentHash, representation),
    ...(body === undefined ? {} : { 'content-digest': contentDigest(body) }),
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
