/**
 * Sharing a form — design §20.3, "Sharing a form"; spec §6.3, §7.3.
 *
 * "How an unpublished Profile's content is conveyed to a partner, and in what
 * form, is outside this specification" (spec §7.3). This file gives the
 * workspace two forms of it — a link, which is just the address the form
 * already answers at, and a file, the CARRIER defined here — and the checks
 * an import runs on what arrives by either.
 *
 * Nothing here touches a database. The carrier is built from a form, and read
 * back into items; whether an item may land on a host is the store's
 * question, asked in `share.ts`.
 */

import { contentHash } from '../profile/store.ts';
import { nameProblem, tlpOf } from '../names.ts';
import { intake } from './store.ts';

export const CARRIER_FORMAT = 'cnscp-share/1';
/** Share writes one; the format allows a few, so a later "share all" needs no second format. */
export const CARRIER_MAX_ITEMS = 50;

export type CarrierItem = {
  name: string;
  kind: 'unpublished' | 'test';
  /** The form's ETag — its content hash, quoted. */
  etag: string;
  updated_at: string;
  /** Exactly what `GET /<name>:unpublished` serves: the 2026 shape, Status Unpublished, no Version, no Pub Date. */
  document: Record<string, unknown>;
};

export type Carrier = {
  carrier: typeof CARRIER_FORMAT;
  shared: {
    at: string;
    /** The host the form was first shared from. Null only when it reached a host as a bare document. */
    from: string | null;
    /** Hosts it has passed through since, oldest first. */
    via: string[];
    /** The organization that runs the sharing host, as canon records it, when the host says. */
    operator: string | null;
  };
  items: CarrierItem[];
};

export function kindOf(name: string): CarrierItem['kind'] {
  return tlpOf(name) === 'test' ? 'test' : 'unpublished';
}

export function buildCarrier(input: {
  at: Date;
  from: string | null;
  via: string[];
  operator: string | null;
  items: { name: string; etag: string; updated_at: Date; document: Record<string, unknown> }[];
}): Carrier {
  return {
    carrier: CARRIER_FORMAT,
    shared: { at: input.at.toISOString(), from: input.from, via: input.via, operator: input.operator },
    items: input.items.map((i) => ({
      name: i.name,
      kind: kindOf(i.name),
      etag: i.etag,
      updated_at: i.updated_at.toISOString(),
      document: i.document,
    })),
  };
}

/** One thing to import, before the host has said whether it may land. */
export type Incoming = {
  name: string;
  document: Record<string, unknown> | null;
  /** The hash the sender claims, unquoted; null for a bare document, which claims none. */
  claimed: string | null;
};

export type IncomingSet = {
  origin: string | null;
  verified: boolean;
  via: string[];
  link: string | null;
  items: Incoming[];
};

export type ParseRefusal = { refused: 'not-a-carrier'; detail: string };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The ETag stripped to the bare hash: quotes and a weak prefix removed. */
export function bareHash(etag: string): string {
  return etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** The hash the workspace would store for this document — what its ETag would be (§20.3). */
export function hashOf(document: Record<string, unknown>): string {
  return contentHash(intake(document));
}

/**
 * Read a request body as a carrier, or as a bare 2026 document. Anything
 * else is refused whole; a carrier's items are checked one by one later, so
 * one bad item never sinks the rest.
 */
export function parseIncoming(body: unknown): IncomingSet | ParseRefusal {
  if (!isObject(body)) return { refused: 'not-a-carrier', detail: 'Import takes a carrier (a .cp.json file Share produced), a 2026-shape Profile document, or { "link": … }.' };

  if (isObject(body['Header'])) {
    const name = (body['Header'] as Record<string, unknown>)['Name'];
    if (typeof name !== 'string') return { refused: 'not-a-carrier', detail: 'The document carries no Header.Name, so there is no name to import it under.' };
    return { origin: null, verified: false, via: [], link: null, items: [{ name, document: body, claimed: null }] };
  }

  if (body['carrier'] !== CARRIER_FORMAT) {
    return {
      refused: 'not-a-carrier',
      detail: `Not a carrier this host reads: "carrier" is ${JSON.stringify(body['carrier'] ?? null)}, and this host reads "${CARRIER_FORMAT}".`,
    };
  }
  const shared = isObject(body['shared']) ? body['shared'] : {};
  const items = body['items'];
  if (!Array.isArray(items) || items.length === 0) return { refused: 'not-a-carrier', detail: 'The carrier has no items.' };
  if (items.length > CARRIER_MAX_ITEMS) return { refused: 'not-a-carrier', detail: `The carrier has ${items.length} items; a carrier holds at most ${CARRIER_MAX_ITEMS}.` };

  const from = typeof shared['from'] === 'string' ? originOf(shared['from']) : null;
  const via = Array.isArray(shared['via']) ? shared['via'].filter((v): v is string => typeof v === 'string').map((v) => originOf(v) ?? v) : [];
  return {
    origin: from,
    verified: false, // a file's origin is only ever as stated
    via,
    link: null,
    items: items.map((item) => {
      const i = isObject(item) ? item : {};
      return {
        name: typeof i['name'] === 'string' ? i['name'] : '',
        document: isObject(i['document']) ? (i['document'] as Record<string, unknown>) : null,
        claimed: typeof i['etag'] === 'string' ? bareHash(i['etag']) : null,
      };
    }),
  };
}

/** A URL reduced to its origin, or null if it is not one. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

// --- links ---------------------------------------------------------------------

export type LinkTarget = { url: URL; name: string; reference: 'unpublished' | 'test' };
export type LinkRefusal = { refused: 'link-shape' | 'link-scheme'; detail: string };

/**
 * Is this a Share link? Exactly two shapes, under any base path:
 * `…/<name>:unpublished`, and `…/test.<…>` with no version.
 */
export function parseLink(link: string, options: { allowHttp: boolean }): LinkTarget | LinkRefusal {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return { refused: 'link-shape', detail: 'That is not a URL. A Share link looks like https://<host>/<name>:unpublished, or https://<host>/test.<…>.' };
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return {
      refused: 'link-scheme',
      detail: `Links are fetched over HTTPS only, so the origin is verified (§20.3). ${url.protocol === 'http:' ? 'A host on a developer\'s machine may admit plain HTTP with WORKSPACE_IMPORT_HTTP=true.' : ''}`.trim(),
    };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { refused: 'link-shape', detail: 'A Share link carries no credentials, query or fragment.' };
  }
  const last = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const colon = last.indexOf(':');
  const name = colon === -1 ? last : last.slice(0, colon);
  const suffix = colon === -1 ? null : last.slice(colon + 1);
  if (nameProblem(name)) return { refused: 'link-shape', detail: `"${last}" does not end in a Profile name.` };
  if (suffix === 'unpublished') return { url, name, reference: 'unpublished' };
  if (suffix === null && tlpOf(name) === 'test') return { url, name, reference: 'test' };
  return {
    refused: 'link-shape',
    detail: `A Share link names an unpublished form — /${name}:unpublished — or a test name; "${last}" is ${suffix === null ? 'a published name, which travels with its chain, not by sharing' : 'not one of those'}.`,
  };
}

export type LinkResponse = { status: number; headers: Record<string, string | undefined>; body: string };
export type LinkFetch = (url: URL) => Promise<LinkResponse>;

export const LINK_MAX_BYTES = 256 * 1024;
export const LINK_TIMEOUT_MS = 10_000;

/**
 * The real fetch, held to the narrow terms of §20.3: no redirect followed,
 * a size cap, a time limit, and the 2026 shape asked for. Headers are
 * lower-cased. Throws on a network failure; the caller turns that into an
 * item-level refusal.
 */
export const fetchLink: LinkFetch = async (url) => {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/cp+json; profile=2026' },
    signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const declared = Number(headers['content-length'] ?? '0');
  if (declared > LINK_MAX_BYTES) throw new Error(`the answer is ${declared} bytes; a shared form is at most ${LINK_MAX_BYTES}`);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LINK_MAX_BYTES) {
        await reader.cancel();
        throw new Error(`the answer exceeds ${LINK_MAX_BYTES} bytes; a shared form is at most that`);
      }
      chunks.push(value);
    }
  }
  return { status: response.status, headers, body: Buffer.concat(chunks).toString('utf8') };
};

/**
 * Read what a link answered as one incoming item, or say why not. The answer
 * must be the workspace's — `x-cp-surface: workspace`, `x-cp-status:
 * unpublished` — so a link can never smuggle a published version, or any
 * other page, in as a form.
 */
export function incomingFromLink(target: LinkTarget, response: LinkResponse): IncomingSet | { refused: 'link-answer'; detail: string } {
  const where = target.url.origin;
  if (response.status >= 300 && response.status < 400) {
    return { refused: 'link-answer', detail: `${where} answered with a redirect, which an import never follows (§20.3).` };
  }
  if (response.status !== 200) {
    return { refused: 'link-answer', detail: `${where} answered ${response.status}: it holds no form there that it will share.` };
  }
  if (response.headers['x-cp-surface'] !== 'workspace' || response.headers['x-cp-status'] !== 'unpublished') {
    return { refused: 'link-answer', detail: `${where} did not answer as a workspace (no x-cp-surface: workspace / x-cp-status: unpublished), so what it sent is not a shared form.` };
  }
  const etag = response.headers['etag'];
  if (!etag) return { refused: 'link-answer', detail: `${where} sent no ETag, so the form cannot be pinned to what was received.` };
  let document: unknown;
  try {
    document = JSON.parse(response.body);
  } catch {
    return { refused: 'link-answer', detail: `${where} did not answer with JSON.` };
  }
  if (!isObject(document)) return { refused: 'link-answer', detail: `${where} did not answer with a document.` };

  // A copy re-shared by link names its first origin; this host verified only the hop it fetched.
  const sharedFrom = response.headers['x-cp-shared-from'];
  const reshared = sharedFrom !== undefined;
  const earlier = (response.headers['x-cp-shared-via'] ?? '')
    .split(',')
    .map((v) => originOf(v.trim()))
    .filter((v): v is string => v !== null);
  return {
    origin: reshared ? (sharedFrom === 'unknown' ? null : originOf(sharedFrom)) : where,
    verified: !reshared,
    via: reshared ? [...earlier, where] : [],
    link: target.url.toString(),
    items: [{ name: target.name, document, claimed: bareHash(etag) }],
  };
}
