/**
 * Resolution — design §19, spec §7.4 and §9.3.
 *
 * Canonical host `https://cp.cnscp.io`, on the RESOLUTION PROFILE of the host
 * contract (§4.4): every GET here, and nothing else. This is the only part of
 * the system other people deploy, which is why its wire contract is the hardest
 * thing to change later and why there is no write verb anywhere in this file.
 *
 * ROUTING IS ONE RULE: does the first path segment contain a dot? A dot means a
 * Profile name; no dot means console, API, or an allocation. The two can never
 * collide, because a Profile name always has at least two segments (spec §7.2)
 * and no reserved path contains a dot. Fastify prefers static routes over
 * parametric ones, so `/health` and `/profiles` win over `/:ref` without
 * ordering tricks — and §3.2 withholds every reserved path as a Prefix so a
 * dotless segment can never shadow one.
 *
 * Versions use `:` and sub-resources use `/`, so `acme.meter.flow:2` arrives as
 * a single path segment and `acme.meter.flow/registration` as two.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Queryable } from '../db.ts';
import { isTlp, nameProblem, tlpOf } from '../names.ts';
import { availability } from '../policy.ts';
import { serializeProfile as serializeLegacy } from '../profile/legacy.ts';
import { parseProfileVersion } from '../profile/spec2026.ts';
import {
  namesBeginningWith,
  resolveAllocation,
  resolveDraft,
  resolveName,
  resolveVersion,
  type ResolvedVersion,
} from './store.ts';
import {
  MEDIA,
  draftHeaders,
  etagMatches,
  immutableVersionHeaders,
  negotiate,
  selectionHeaders,
  versionETag,
  type Representation,
} from './http.ts';

export type ResolutionDeps = {
  db: Queryable;
  /** Rendering is a courtesy; a JSON-only instance is fully conforming (§19.1). */
  html?: boolean;
};

/** `acme.meter.flow:2` → name and version. The colon is the version separator. */
export function splitReference(segment: string): { name: string; version: number | 'draft' | null } {
  const colon = segment.lastIndexOf(':');
  if (colon === -1) return { name: segment, version: null };

  const name = segment.slice(0, colon);
  const versionPart = segment.slice(colon + 1);
  if (versionPart === 'draft') return { name, version: 'draft' };
  if (/^[0-9]+$/.test(versionPart)) return { name, version: Number(versionPart) };
  return { name, version: NaN as unknown as number };
}

function mediaTypeFor(representation: Representation): string {
  return representation === 'html' ? MEDIA.html : representation === 'legacy' ? MEDIA.legacy : MEDIA.spec2026;
}

/**
 * The legacy shape, rebuilt from the stored 2026 document.
 *
 * Goes through the model both ways rather than storing two copies, because two
 * stored copies can disagree and the mapper is proven lossless in the goldens.
 */
function toLegacy(version: ResolvedVersion): unknown {
  const profile = parseProfileVersion(version.content as never);
  return serializeLegacy(profile);
}

function applyHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) reply.header(key, value);
}

export async function registerResolutionRoutes(app: FastifyInstance, deps: ResolutionDeps): Promise<void> {
  const { db } = deps;
  const renderHtml = deps.html ?? true;

  app.get('/health', async () => ({ ok: true, part: 'three', surface: 'resolution' }));

  /**
   * The catalog. `/profiles` lists; `/profiles/<name>` is the compatibility
   * alias ARETE.md documents, and it defaults to the LEGACY shape because that
   * is what the deployed SDKs fetching this path expect (§19.2).
   */
  app.get<{ Params: { '*': string } }>('/profiles/*', async (request, reply) => {
    const segment = request.params['*'];
    return resolveOne(request.headers.accept, segment, reply, 'legacy');
  });

  app.get('/profiles', async () => ({
    note: 'Catalog and search. Resolution is at the root: GET /<name>.',
  }));

  /** `GET /<name>/registration` — spec §9.3: answers that a name is registered, and since when. */
  app.get<{ Params: { ref: string } }>('/:ref/registration', async (request, reply) => {
    const { name } = splitReference(request.params.ref);
    if (nameProblem(name)) return reply.code(400).send({ error: 'not a well-formed Profile name' });

    const registered = await resolveName(db, name);
    if (!registered) return reply.code(404).send({ registered: false, name });

    return reply.header('cache-control', 'no-cache').send({
      registered: true,
      name: registered.name,
      since: registered.registered_at,
      versions: registered.versions.map((v) => ({ version: v.version, status: v.status })),
      ...(registered.imported_from ? { imported_from: registered.imported_from } : {}),
    });
  });

  /** The root resolution route. A dot means a Profile; no dot means an allocation. */
  app.get<{ Params: { ref: string } }>('/:ref', async (request, reply) => {
    const segment = request.params.ref;

    // A single dotless segment denotes an allocation (spec §7.1, §19.3).
    if (!segment.includes('.') && !segment.includes(':')) {
      return allocationPage(segment, request.headers.accept, reply);
    }

    return resolveOne(request.headers.accept, segment, reply, 'spec2026');
  });

  // --- handlers -------------------------------------------------------------

  async function resolveOne(
    accept: string | undefined,
    segment: string,
    reply: FastifyReply,
    fallback: Representation,
  ): Promise<unknown> {
    const representation = negotiate(accept, fallback);
    const { name, version } = splitReference(segment);

    if (Number.isNaN(version)) {
      return reply.code(400).send({ error: 'a version is an integer or the reserved token "draft" (spec §7.2)' });
    }

    const problem = nameProblem(name);
    if (problem === 'single-segment') {
      return reply.code(400).send({
        error: 'a one-segment reference denotes an allocation, not a Profile (spec §7.2)',
      });
    }
    if (problem) return reply.code(400).send({ error: `not a well-formed Profile name (${problem})` });

    if (version === 'draft') return draft(name, representation, reply);

    const registered = await resolveName(db, name);
    if (!registered) return notFound(name, representation, reply);

    // No version given: the SELECTION SURFACE (§17 Match, §18). Which versions
    // exist and which are Deprecated. Revalidated, never immutable.
    if (version === null) {
      const etag = `"${name}-${registered.versions.map((v) => `${v.version}${v.status[0]}`).join('.')}"`;
      applyHeaders(reply, selectionHeaders(etag));

      if (etagMatches(reply.request.headers['if-none-match'], etag)) return reply.code(304).send();

      const body = {
        name: registered.name,
        registered: registered.registered_at,
        versions: registered.versions.map((v) => ({
          version: v.version,
          status: v.status,
          published: v.published_at,
          content_hash: v.content_hash,
          href: `/${name}:${v.version}`,
        })),
      };

      if (representation === 'html' && renderHtml) {
        return reply.type(MEDIA.html).send(renderVersionList(body));
      }
      return reply.type(mediaTypeFor(representation)).send(body);
    }

    // A specific version: the CONTRACT. Immutable (§18).
    const resolved = await resolveVersion(db, name, version);
    if (!resolved) {
      return reply.code(404).send({ error: `no version ${version} of "${name}"`, name, version });
    }

    const etag = versionETag(resolved.content_hash, representation);
    applyHeaders(reply, immutableVersionHeaders(resolved.content_hash, representation));

    if (etagMatches(reply.request.headers['if-none-match'], etag)) return reply.code(304).send();

    // Deprecation is surfaced ADDITIVELY — extra keys, never a mutation of the
    // version's Properties (§19).
    reply.header('x-cp-status', resolved.status);
    if (resolved.grandfathered) reply.header('x-cp-grandfathered', 'true');

    if (representation === 'html' && renderHtml) {
      return reply.type(MEDIA.html).send(renderVersion(resolved));
    }

    if (representation === 'legacy') {
      return reply.type(MEDIA.legacy).send(toLegacy(resolved));
    }

    // The 2026 shape, served from the STORED BYTES where we have them. Spec
    // §9.3 requires one name and version never be answered with differing
    // content; replaying the bytes is what guarantees it, rather than trusting
    // a serializer to be deterministic across deployments (§19.2).
    if (resolved.served_bytes) {
      return reply.type(MEDIA.spec2026).send(resolved.served_bytes.toString('utf8'));
    }
    return reply.type(MEDIA.spec2026).send(resolved.content);
  }

  async function draft(name: string, representation: Representation, reply: FastifyReply): Promise<unknown> {
    const held = await resolveDraft(db, name);
    applyHeaders(reply, draftHeaders());

    // Spec §9.3: the Registry SHALL NOT answer inquiries for a Draft's content
    // except as its owner authorizes, and SHALL answer them from any party once
    // the owner has authorized a Realm it does not operate. This instance
    // serves the anonymous read path, so only `public` is answerable here;
    // `authorized` requires knowing WHICH Realm is asking, which is the
    // authoritative host's business (§4.4).
    if (!held || held.disclosure !== 'public') {
      return reply.code(404).send({
        error: 'no Draft is answerable for this name',
        name,
        note: 'A Draft is answered only as its owner authorizes (spec §7.3).',
      });
    }

    if (representation === 'html' && renderHtml) {
      return reply.type(MEDIA.html).send(renderDraft(name, held.content));
    }
    return reply.type(mediaTypeFor(representation === 'legacy' ? 'legacy' : 'spec2026')).send(held.content);
  }

  async function allocationPage(
    tlp: string,
    accept: string | undefined,
    reply: FastifyReply,
  ): Promise<unknown> {
    if (!isTlp(tlp)) return reply.code(400).send({ error: 'not a well-formed Top Level Prefix' });

    const representation = negotiate(accept, 'legacy');
    const page = await resolveAllocation(db, tlp);

    if (!page) {
      const policy = availability(tlp);
      return reply.code(404).send({ tlp, allocated: false, ...(policy.available ? {} : { policy }) });
    }

    reply.header('cache-control', 'no-cache').header('vary', 'Accept');

    const body = {
      reference: `cp:${tlp}`,
      tlp: page.tlp,
      holder: page.holder,
      grandfathered: page.grandfathered,
      names: page.names.map((n) => ({
        name: n.name,
        registered: n.registered_at,
        versions: n.versions.map((v) => ({ version: v.version, status: v.status })),
        href: `/${n.name}`,
      })),
      catalog: `/profiles?prefix=${tlp}`,
    };

    if (representation === 'html' && renderHtml) return reply.type(MEDIA.html).send(renderAllocation(body));
    return reply.type(representation === 'spec2026' ? MEDIA.spec2026 : MEDIA.legacy).send(body);
  }

  /**
   * 404 for an unregistered name — and NOT an index.
   *
   * §19.3: `GET /acme.meter` when only `acme.meter.flow` is registered is a 404
   * in the machine representations, because `acme.meter` is not a registered
   * name and the specification places no structure below a Prefix. The HTML
   * page may offer a search affordance, clearly framed as a search over
   * strings — a helpful index that behaved like a node would quietly
   * reintroduce the name hierarchy CNS/CP does not have.
   */
  async function notFound(name: string, representation: Representation, reply: FastifyReply): Promise<unknown> {
    reply.code(404).header('cache-control', 'no-cache');

    if (representation === 'html' && renderHtml) {
      const beginning = await namesBeginningWith(db, name);
      return reply.type(MEDIA.html).send(renderNotFound(name, beginning));
    }

    return reply.send({
      registered: false,
      name,
      note: 'No relationship may be inferred between names (spec §7.7); this is not an index.',
    });
  }
}

// --- HTML (§19.1) -----------------------------------------------------------
//
// "The page never summarizes. It is a presentation of the same document, not a
// digest of it." ARETE.md warns that rendered views lose key-presence flags,
// which happens when a view decides some fields are uninteresting — so this one
// decides nothing, and prints every attribute of every Property.

function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
code{background:#f4f4f4;padding:.1rem .3rem}.raw{margin:1.5rem 0;padding:.75rem;background:#f8f8f8;border-left:3px solid #666}</style>
${body}`;
}

function renderVersion(version: ResolvedVersion): string {
  const document = version.content as { Header?: Record<string, unknown>; Properties?: Record<string, unknown[]> };
  const header = document.Header ?? {};
  const properties = document.Properties ?? {};

  const headerRows = Object.entries(header)
    .map(([k, v]) => `<tr><th>${escape(k)}</th><td>${escape(v)}</td></tr>`)
    .join('');

  const roleTables = (['Provider', 'Consumer'] as const)
    .map((role) => {
      const list = (properties[role] ?? []) as Record<string, unknown>[];
      if (list.length === 0) return `<h3>${role}</h3><p>No Properties.</p>`;
      // Every attribute of every Property, always. No column is dropped for
      // being uninteresting — that is how key-presence flags get lost.
      const keys = [...new Set(list.flatMap((p) => Object.keys(p)))];
      const head = keys.map((k) => `<th>${escape(k)}</th>`).join('');
      const rows = list
        .map((p) => `<tr>${keys.map((k) => `<td>${k in p ? escape(p[k]) : '<em>absent</em>'}</td>`).join('')}</tr>`)
        .join('');
      return `<h3>${role}</h3><table><tr>${head}</tr>${rows}</table>`;
    })
    .join('');

  const shortfall =
    version.missing_header_fields.length > 0
      ? `<p><strong>This version does not carry every REQUIRED Header field (spec §6.4):</strong>
         ${version.missing_header_fields.map(escape).join(', ')}. It was imported from an earlier
         registry and the gaps are recorded rather than filled.</p>`
      : '';

  return page(
    `${version.name}:${version.version}`,
    `<h1><code>cp:${escape(version.name)}:${version.version}</code></h1>
     <p>Status: <strong>${escape(version.status)}</strong>${version.grandfathered ? ' · grandfathered' : ''}
     ${version.pub_date_approximate ? ' · publication date approximate' : ''}</p>
     ${shortfall}
     <h2>Header</h2><table>${headerRows}</table>
     <h2>Properties</h2>${roleTables}
     <div class="raw"><strong>The contract is the document, not this page.</strong>
       <code>GET /${escape(version.name)}:${version.version}</code>
       with <code>Accept: application/cp+json; profile=2026</code>.
       SHA-256 <code>${escape(version.content_hash)}</code>.</div>`,
  );
}

function renderVersionList(body: {
  name: string;
  registered: Date;
  versions: { version: number; status: string; published: Date; href: string }[];
}): string {
  const rows = body.versions
    .map(
      (v) =>
        `<tr><td><a href="${escape(v.href)}">${v.version}</a></td><td>${escape(v.status)}</td><td>${escape(
          new Date(v.published).toISOString().slice(0, 10),
        )}</td></tr>`,
    )
    .join('');

  return page(
    body.name,
    `<h1><code>cp:${escape(body.name)}</code></h1>
     <p>Registered ${escape(new Date(body.registered).toISOString().slice(0, 10))}.</p>
     ${body.versions.length === 0
       ? '<p>No published versions. The name is registered and holds a Draft (spec §7.3).</p>'
       : `<table><tr><th>Version</th><th>Status</th><th>Published</th></tr>${rows}</table>`}`,
  );
}

function renderAllocation(body: {
  tlp: string;
  holder: string | null;
  names: { name: string; versions: { version: number; status: string }[]; href: string }[];
}): string {
  const rows = body.names
    .map(
      (n) =>
        `<tr><td><a href="${escape(n.href)}">${escape(n.name)}</a></td><td>${
          n.versions.length === 0 ? '<em>none published</em>' : n.versions.map((v) => v.version).join(', ')
        }</td></tr>`,
    )
    .join('');

  return page(
    `cp:${body.tlp}`,
    `<h1><code>cp:${escape(body.tlp)}</code></h1>
     <p>Held by ${escape(body.holder ?? 'the operator')}.</p>
     <table><tr><th>Name</th><th>Versions</th></tr>${rows}</table>`,
  );
}

function renderDraft(name: string, content: unknown): string {
  return page(
    `${name}:draft`,
    `<h1><code>cp:${escape(name)}:draft</code></h1>
     <p><strong>This is a Draft.</strong> It may change at any time and is not a contract (spec §6.2).</p>
     <pre>${escape(JSON.stringify(content, null, 2))}</pre>`,
  );
}

function renderNotFound(name: string, beginning: string[]): string {
  // Framed as a search over strings, explicitly. Not an index.
  const search =
    beginning.length > 0
      ? `<p>No such Profile — but ${beginning.length} registered name${beginning.length === 1 ? '' : 's'}
         begin <code>${escape(name)}.</code> as a string. This is a text search, not a hierarchy:
         no relationship may be inferred between names (spec §7.7).</p>
         <ul>${beginning.map((n) => `<li><a href="/${escape(n)}">${escape(n)}</a></li>`).join('')}</ul>`
      : '<p>No such Profile.</p>';

  return page(`${name} — not found`, `<h1><code>${escape(name)}</code></h1>${search}`);
}
