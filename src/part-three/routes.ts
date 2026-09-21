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
import type pg from 'pg';
import type { Queryable } from '../db.ts';
import { isTlp, nameProblem, tlpOf } from '../names.ts';
import { availability } from '../policy.ts';
import { serializeProfile as serializeLegacy } from '../profile/legacy.ts';
import { parseProfileVersion } from '../profile/spec2026.ts';
import {
  namesBeginningWith,
  resolveAllocation,
  resolveIndex,
  resolveName,
  resolveVersion,
  searchCatalog,
  type CatalogQuery,
  type ResolvedVersion,
  type VersionSummary,
} from './store.ts';
import { registerDistributionRoutes } from '../distribution/routes.ts';
import type { Role } from '../distribution/store.ts';
import { presentVersion } from './present.ts';
import {
  MEDIA,
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
  /**
   * Distribution (§20) is part of the resolution profile and mounts here when
   * `db` is a pool (the snapshot needs a transaction of its own). An instance
   * says so, and names its upstream; the default is the authoritative store.
   */
  role?: Role;
  upstream?: string;
  /**
   * The workspace beside an instance (§20.3), when this host runs one. The
   * Registry surface is unchanged by its presence: every machine
   * representation of every Registry URL answers as canon does. What the
   * hooks add is the AUTHOR'S answer at `:unpublished`, and a pill and a
   * link on the human pages.
   */
  workspace?: WorkspaceHooks;
};

/** What a name page shows for the workspace's form, when this host holds one. */
export type UnpublishedPill = { href: string; note: string | null };

export type WorkspaceHooks = {
  /**
   * `GET /<name>:unpublished` in a machine or HTML representation. Sends the
   * author's answer and returns true, or returns false to leave the Registry's
   * own answer — the 404 of §13.3 — in place. Never called for the legacy
   * representation: the 2022 shape has no Unpublished status to carry.
   */
  unpublished(name: string, representation: Representation, reply: FastifyReply): Promise<boolean>;
  /** Which of these names this host holds a form for, with the pill's note. */
  held(names: string[]): Promise<Map<string, UnpublishedPill>>;
  /** For `/health` and `/distribution/status`: the host's second hat, visible. */
  summary(): Promise<Record<string, unknown>>;
};

/** `acme.meter.flow:2` → name and version. The colon is the version separator. */
export function splitReference(segment: string): { name: string; version: number | 'unpublished' | null } {
  const colon = segment.lastIndexOf(':');
  if (colon === -1) return { name: segment, version: null };

  const name = segment.slice(0, colon);
  const versionPart = segment.slice(colon + 1);
  if (versionPart === 'unpublished') return { name, version: 'unpublished' };
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
  // From the ANSWER, not the frozen row: the legacy shape carries Owner and
  // Website too (company / website), and they follow stewardship (§18).
  const profile = parseProfileVersion(presentVersion(version).document as never);
  return serializeLegacy(profile);
}

function applyHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) reply.header(key, value);
}

export async function registerResolutionRoutes(app: FastifyInstance, deps: ResolutionDeps): Promise<void> {
  const { db } = deps;
  const renderHtml = deps.html ?? true;

  const workspace = deps.workspace;
  app.get('/health', async () => ({
    ok: true,
    part: 'three',
    surface: 'resolution',
    role: deps.role ?? 'authoritative',
    ...(workspace ? { workspace: await workspace.summary() } : {}),
  }));

  // §20: the feed is served wherever resolution is. It needs a pool because
  // the snapshot takes a REPEATABLE READ transaction of its own.
  if (typeof (db as Partial<pg.Pool>).connect === 'function') {
    await registerDistributionRoutes(app, {
      pool: db as pg.Pool,
      role: deps.role ?? 'authoritative',
      ...(deps.upstream ? { upstream: deps.upstream } : {}),
      ...(workspace ? { workspace: () => workspace.summary() } : {}),
    });
  }

  /** The pills and links the human pages add when this host holds forms; empty when it runs no workspace. */
  const heldBy = async (names: string[]): Promise<Map<string, UnpublishedPill>> =>
    workspace && names.length > 0 ? workspace.held(names) : new Map();

  /**
   * The root index. Every allocated Top Level Prefix — stable public facts
   * only, exactly as the per-allocation page (§19.3). A selection surface,
   * revalidated, never immutable.
   */
  app.get('/', async (request, reply) => {
    const representation = negotiate(request.headers.accept, 'legacy');
    const allocations = await resolveIndex(db);

    reply.header('cache-control', 'no-cache').header('vary', 'Accept');

    const body = {
      registry: 'Connection Profile Registry',
      allocations: allocations.map((a) => ({
        reference: `cp:${a.tlp}`,
        tlp: a.tlp,
        holder: a.holder,
        grandfathered: a.grandfathered,
        names: a.names,
        published_versions: a.published_versions,
        published_names: a.published_names,
        unpublished_names: a.unpublished_names,
        href: `/${a.tlp}`,
      })),
      catalog: '/profiles',
    };

    if (representation === 'html' && renderHtml) return reply.type(MEDIA.html).send(renderIndex(body.allocations));
    return reply.type(representation === 'spec2026' ? MEDIA.spec2026 : MEDIA.legacy).send(body);
  });

  /**
   * The catalog. `/profiles` lists; `/profiles/<name>` is the compatibility
   * alias ARETE.md documents, and it defaults to the LEGACY shape because that
   * is what the deployed SDKs fetching this path expect (§19.2).
   */
  app.get<{ Params: { '*': string } }>('/profiles/*', async (request, reply) => {
    const segment = request.params['*'];
    return resolveOne(request.headers.accept, segment, reply, 'legacy');
  });

  /**
   * The catalog: a page of registered names, searchable. `?q=` is a substring
   * search over names and published Headers; `?prefix=` filters to a string
   * prefix at a segment boundary. Framed as a search over strings in both
   * representations, because a catalog that behaved like an index would
   * quietly reintroduce the hierarchy CNS/CP does not have (spec §7.7).
   */
  app.get<{ Querystring: { q?: string; prefix?: string; limit?: string; offset?: string } }>(
    '/profiles',
    async (request, reply) => {
      const representation = negotiate(request.headers.accept, 'legacy');
      const { q, prefix } = request.query;

      if (prefix !== undefined && !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/.test(prefix)) {
        return reply.code(400).send({ error: 'not a well-formed prefix: lowercase segments, dot-separated' });
      }
      if (q !== undefined && q.length > 200) {
        return reply.code(400).send({ error: 'the search string is limited to 200 characters' });
      }

      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return reply.code(400).send({ error: 'limit is an integer from 1 to 200' });
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return reply.code(400).send({ error: 'offset is a non-negative integer' });
      }

      const query: CatalogQuery = { limit, offset };
      if (q) query.q = q;
      if (prefix) query.prefix = prefix;

      const result = await searchCatalog(db, query);
      reply.header('cache-control', 'no-cache').header('vary', 'Accept');

      const pageHref = (pageOffset: number): string => {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (prefix) params.set('prefix', prefix);
        if (limit !== 50) params.set('limit', String(limit));
        if (pageOffset > 0) params.set('offset', String(pageOffset));
        const rendered = params.toString();
        return rendered ? `/profiles?${rendered}` : '/profiles';
      };

      const body = {
        query: { ...(q ? { q } : {}), ...(prefix ? { prefix } : {}), limit, offset },
        total: result.total,
        count: result.entries.length,
        entries: result.entries.map((e) => ({
          name: e.name,
          registered: e.registered_at,
          ...(e.title === null ? {} : { title: e.title }),
          versions: e.versions.map((v) => ({ version: v.version, status: v.status })),
          href: `/${e.name}`,
        })),
        ...(offset + result.entries.length < result.total ? { next: pageHref(offset + limit) } : {}),
        ...(offset > 0 ? { prev: pageHref(Math.max(0, offset - limit)) } : {}),
        note: 'A text search over registered names and published Headers. No relationship may be inferred between names (spec §7.7); this is not an index.',
      };

      if (representation === 'html' && renderHtml) {
        return reply.type(MEDIA.html).send(renderCatalog(body, await heldBy(body.entries.map((e) => e.name))));
      }
      return reply.type(representation === 'spec2026' ? MEDIA.spec2026 : MEDIA.legacy).send(body);
    },
  );

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
      return reply.code(400).send({ error: 'a version is an integer or the reserved token "unpublished" (spec §7.2)' });
    }

    const problem = nameProblem(name);
    if (problem === 'single-segment') {
      return reply.code(400).send({
        error: 'a one-segment reference denotes an allocation, not a Profile (spec §7.2)',
      });
    }
    if (problem) return reply.code(400).send({ error: `not a well-formed Profile name (${problem})` });

    if (version === 'unpublished') {
      // A host that runs a workspace beside its instance (§20.3) answers here
      // AS THE AUTHOR — the conveyance spec §7.3 leaves to the author — and
      // only for a form it holds under a name it may hold. The Registry
      // surface's own answer follows for everything else, and always for
      // the legacy shape, which cannot carry an Unpublished status.
      if (workspace && representation !== 'legacy' && (await workspace.unpublished(name, representation, reply))) {
        return reply;
      }
      // Spec §7.2: "a reference the Registry never resolves; only a Realm
      // holding its content can". Spec §7.3, §9.3: the Registry SHALL NOT
      // hold, serve, or answer for unpublished content — so this is not a
      // permission question, and no credential changes the answer.
      reply.code(404).header('cache-control', 'no-store');
      return reply.send({
        name,
        resolvable: false,
        note: 'An unpublished reference is never resolved by the Registry (spec §7.2, §7.3): its content lives with its author, and reaches a Realm only as the author conveys it.',
      });
    }

    const registered = await resolveName(db, name);
    if (!registered) return notFound(name, representation, reply);

    // No version given: the SELECTION SURFACE (§17 Match, §18). Which versions
    // exist and which are Deprecated. Revalidated, never immutable.
    if (version === null) {
      // The representation is part of the entity here exactly as it is for a
      // versioned fetch (see versionETag): the HTML page and the JSON list
      // are different bodies with the same underlying facts, and a validator
      // shared between them serves stale HTML after the renderer changes —
      // the browser revalidates, the version list is unchanged, 304, old page.
      const etag = `"${name}-${registered.versions.map((v) => `${v.version}${v.status[0]}`).join('.')}-${representation}"`;
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
          // Stewardship as it stands now (spec §6.6) — additive keys on the
          // revalidated surface, the same way status travels (§18, §19).
          ...(v.header_owner ? { owner: v.header_owner } : {}),
          ...(v.header_website ? { website: v.header_website } : {}),
          href: `/${name}:${v.version}`,
        })),
      };

      if (representation === 'html' && renderHtml) {
        // A courtesy of the HTML representation only: a browser landing on
        // the unversioned URL sees the newest published version's document —
        // what a new Connection would most likely bind — with the other
        // versions one click away. The machine shapes are untouched: this is
        // still the selection surface, still no-cache, and Match still reads
        // the JSON list above.
        const newestFirst = [...registered.versions].sort((a, b) => b.version - a.version);
        const pick = newestFirst.find((v) => v.status === 'published') ?? newestFirst[0];
        const pill = (await heldBy([name])).get(name) ?? null;
        if (pick) {
          const resolved = await resolveVersion(db, name, pick.version);
          if (resolved) {
            return reply.type(MEDIA.html).send(renderVersion(resolved, registered.versions, pill));
          }
        }
        return reply.type(MEDIA.html).send(renderVersionList(body, pill));
      }
      return reply.type(mediaTypeFor(representation)).send(body);
    }

    // A specific version: the CONTRACT. Immutable (§18).
    const resolved = await resolveVersion(db, name, version);
    if (!resolved) {
      return reply.code(404).send({ error: `no version ${version} of "${name}"`, name, version });
    }

    // The CONTRACT is immutable and its machine representations are cached
    // that way (§18). The HTML is a courtesy RENDERING of the contract — the
    // page chrome and layout evolve while the document does not — so it is
    // revalidated like every other page. A year-long immutable HTML cache
    // would pin early visitors to the first design forever.
    if (representation === 'html' && renderHtml) {
      reply.header('cache-control', 'no-cache').header('vary', 'Accept');
      reply.header('x-cp-status', resolved.status);
      if (resolved.grandfathered) reply.header('x-cp-grandfathered', 'true');
      return reply.type(MEDIA.html).send(renderVersion(resolved, registered.versions, (await heldBy([name])).get(name) ?? null));
    }

    const etag = versionETag(resolved.content_hash, representation);
    applyHeaders(reply, immutableVersionHeaders(resolved.content_hash, representation));

    if (etagMatches(reply.request.headers['if-none-match'], etag)) return reply.code(304).send();

    // Deprecation is surfaced ADDITIVELY — extra keys, never a mutation of the
    // version's Properties (§19).
    reply.header('x-cp-status', resolved.status);
    if (resolved.grandfathered) reply.header('x-cp-grandfathered', 'true');

    if (representation === 'legacy') {
      // The deployed shape has no place for Channels or Default (8 Sept
      // revision). Omitting them would serve a changed contract — the exact
      // hazard the goldens exist to catch — so a Channel-bearing version
      // refuses legacy outright. Grandfathered and Channel-free versions
      // keep serving it losslessly, so the deployed fleet is unaffected.
      const document = resolved.content as { Channels?: unknown[] };
      if (Array.isArray(document.Channels) && document.Channels.length > 0) {
        return reply.code(406).type(MEDIA.legacy).send({
          error: 'this version declares Channels, which the legacy serialization cannot carry without changing the contract',
          use: MEDIA.spec2026,
          href: `/${resolved.name}:${resolved.version}`,
        });
      }
      return reply.type(MEDIA.legacy).send(toLegacy(resolved));
    }

    // The 2026 shape, served from the STORED BYTES where we have them. Spec
    // §9.3 requires one name and version never be answered with differing
    // content; replaying the bytes is what guarantees it, rather than trusting
    // a serializer to be deterministic across deployments (§19.2).
    // ...with the three mutable Header fields — Status, Owner, Website —
    // overlaid from the row when they have moved since publication (spec
    // §6.6, §9.3; part-three/present.ts). The ETag and Content-Digest above
    // are the frozen content's: the contract did not change, and a cache
    // that holds the old answer holds a correct contract with stale
    // stewardship, which §18 accepts by design.
    return reply.type(MEDIA.spec2026).send(presentVersion(resolved).text);
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

    if (representation === 'html' && renderHtml) {
      return reply.type(MEDIA.html).send(renderAllocation(body, await heldBy(body.names.map((n) => n.name))));
    }
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

export function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The shared chrome — CNSCP/web's design system (cnscp.io style.css),
 * inlined so the registry stays self-contained. Every rendered page goes
 * through here: same tokens, same header, same footer, one site.
 */
const SITE_STYLE = `
  :root{--blue:#0f6feb;--blue-dark:#0a55b8;--blue-ink:#0b2e5e;--ink:#17222f;--body:#3d4a59;
    --muted:#6b7684;--bg:#fff;--panel:#f5f8fc;--border:#e3e9f1;
    --card-shadow:0 1px 2px rgba(16,35,61,.04),0 8px 24px rgba(16,35,61,.06);
    --radius:14px;--maxw:1080px}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:var(--body);background:var(--bg);line-height:1.65;font-size:17px;
    display:flex;flex-direction:column;min-height:100vh}
  h1,h2,h3{color:var(--ink);line-height:1.25;letter-spacing:-.01em}
  h1{font-size:1.9rem;margin-bottom:.4rem}h2{font-size:1.35rem;margin:1.8rem 0 .5rem}
  h3{font-size:1.05rem;margin:1.4rem 0 .4rem}
  p{margin-bottom:1.1rem}
  a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
  main{flex:1}
  .wrap{max-width:var(--maxw);margin:0 auto;padding:0 22px}
  .site-header{background:rgba(255,255,255,.92);border-bottom:1px solid var(--border)}
  .site-header .bar{max-width:var(--maxw);margin:0 auto;padding:14px 22px;display:flex;align-items:center;gap:14px}
  .brand{display:flex;align-items:center;gap:10px;color:var(--ink);font-weight:700;font-size:1.1rem}
  .brand img{width:30px;height:30px;border-radius:7px}
  .brand:hover{text-decoration:none}
  .tm{font-size:.5em;font-weight:500;vertical-align:super;line-height:0;margin-left:1px;letter-spacing:0}
  .site-nav{margin-left:auto}.site-nav ul{list-style:none;display:flex;gap:4px;flex-wrap:wrap;margin:0}
  .site-nav li,.service-nav li{margin:0}
  /* The Registry's own surfaces, set apart from the six this host shares with
     cnscp.io — so it reads which links stay here and which leave. */
  .service-nav ul{list-style:none;display:flex;gap:4px;flex-wrap:wrap;
    padding-left:14px;margin:0 0 0 2px;border-left:1px solid var(--border)}
  .service-nav a{display:block;padding:7px 12px;border-radius:8px;color:var(--body);font-weight:500;font-size:.95rem}
  .service-nav a:hover{background:var(--panel);color:var(--ink);text-decoration:none}
  .service-nav a.active{color:var(--blue);font-weight:650}
  @media (max-width:760px){.service-nav ul{padding-left:0;border-left:0}}
  .site-nav a{display:block;padding:7px 12px;border-radius:8px;color:var(--body);font-weight:500;font-size:.95rem}
  .site-nav a:hover{background:var(--panel);color:var(--ink);text-decoration:none}
  .site-nav a.active{color:var(--blue);font-weight:650}
  .section{padding:40px 0 10px}
  .section-intro{color:var(--muted);max-width:68ch;margin-bottom:22px}
  .card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);
    box-shadow:var(--card-shadow);padding:6px 0;margin:0 0 22px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;margin:0 0 1.1rem}
  .card table{margin:0}
  th,td{border-bottom:1px solid var(--border);padding:10px 16px;text-align:left;
    vertical-align:top;font-size:.95rem}
  tr:last-child td{border-bottom:0}
  th{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
  td.n,th.n{text-align:right}td.warn{color:#b45309;font-weight:650}
  code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;
    background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:1px 6px;color:var(--blue-ink)}
  h1 code{font-size:.95em;background:transparent;border:0;padding:0;color:inherit}
  .raw,.callout{border-left:4px solid var(--blue);background:var(--panel);
    border-radius:0 10px 10px 0;padding:16px 20px;margin:1.4rem 0;font-size:.95rem}
  .versions{margin:0 0 1.2rem}
  .pill{display:inline-block;padding:4px 14px;border:1px solid var(--border);border-radius:999px;
    font-size:.85rem;margin:0 6px 6px 0;background:#fff;color:var(--body)}
  a.pill:hover{border-color:var(--blue);color:var(--blue);text-decoration:none}
  .pill.current{border-color:var(--blue);background:var(--panel);color:var(--blue-ink);font-weight:650}
  .pill .dep{color:#b45309}
  /* The workspace's form (§20.3): set apart from the versions it is not one of. */
  .pill.unpublished{border-style:dashed;color:#b45309}
  a.pill.unpublished:hover{border-color:#b45309;color:#9a3412}
  .pill.unpublished.current{border-color:#b45309;background:#fff7ed;color:#9a3412;font-weight:650}
  .callout.unpublished{border-left-color:#b45309;background:#fff7ed}
  details{margin:0 0 22px}summary{cursor:pointer;color:var(--muted);font-size:.95rem;padding:4px 2px}
  details .card{margin-top:12px}
  ul{margin:0 0 1.1rem 1.4rem}li{margin-bottom:.45rem}
  em{color:var(--muted)}
  table.attrs{table-layout:fixed}table.attrs td{overflow-wrap:anywhere;vertical-align:top}
  .note{color:var(--muted);font-size:.92rem;margin-top:.5rem}
  .search-row{display:flex;gap:10px;flex-wrap:wrap;max-width:640px;margin-bottom:1.2rem}
  .search-row input{flex:1 1 320px;min-width:0;font:inherit;padding:11px 16px;
    border:1px solid var(--border);border-radius:10px;background:#fff;color:var(--ink)}
  .search-row input:focus{outline:2px solid var(--blue);outline-offset:-1px;border-color:var(--blue)}
  .btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:650;font-size:.98rem;
    border:1px solid transparent;font-family:inherit;cursor:pointer}
  .btn-primary{background:var(--blue);color:#fff}.btn-primary:hover{background:var(--blue-dark);text-decoration:none}
  .hero{background:radial-gradient(1000px 420px at 85% -80px,rgba(15,111,235,.14),transparent 60%),
    radial-gradient(700px 380px at 0% 110%,rgba(15,111,235,.08),transparent 55%),var(--panel);
    border-bottom:1px solid var(--border);padding:64px 0 56px}
  .hero .eyebrow{display:inline-block;font-size:.8rem;font-weight:700;letter-spacing:.08em;
    text-transform:uppercase;color:var(--blue);margin-bottom:14px}
  .hero h1{font-size:2.6rem;max-width:24ch;margin-bottom:16px}
  .hero .lead{font-size:1.15rem;max-width:62ch;margin-bottom:26px}
  .hero .stats{margin-top:16px;font-size:.92rem;color:var(--muted)}
  .hero .section-title,.section h2:first-child{margin-top:0}
  .site-footer{background:#0e1726;color:#aab6c6;margin-top:48px}
  .site-footer .tail{max-width:var(--maxw);margin:0 auto;padding:22px;font-size:.9rem;
    display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
  .site-footer a{color:#aab6c6}.site-footer a:hover{color:#fff}
  @media (max-width:640px){body{font-size:16px}.hero{padding:44px 0 40px}.hero h1{font-size:2rem}}`;

/**
 * The Account link appears only on a host that mounts the identity routes
 * (§15.3) — the authoritative host. A local instance has no sign-in.
 */
/**
 * The site navigation, shared with cnscp.io — design §4.4.
 *
 * The same six items, the same order, the same labels as the website's
 * `nav.json`. They are DUPLICATED rather than fetched: §4.4 gives each host
 * its own console on its own origin so that no console makes a cross-origin
 * call, and the Registry is the thing that has to keep answering when other
 * things are down. A header pulled from cnscp.io would make every Profile
 * page depend on a static site being up.
 *
 * Duplication that nothing checks is how the licence texts drifted across
 * this estate, so `test/nav.test.ts` compares this list against the website's
 * `nav.json` when that repository is checked out beside this one, and skips
 * when it is not — the `verify-spec` pattern.
 *
 * `Registry` is this host's own root; everything else leaves.
 */
export const SITE_NAV: readonly { id: string; label: string; href: string }[] = [
  { id: 'home', label: 'Home', href: 'https://cnscp.io' },
  { id: 'registry', label: 'Registry', href: '/' },
  { id: 'spec', label: 'Specification', href: 'https://github.com/CNSCP/specification' },
  { id: 'legal', label: 'Legal', href: 'https://cnscp.io/license/' },
  { id: 'about', label: 'About', href: 'https://cnscp.io/about.html' },
  { id: 'contact', label: 'Contact', href: 'https://cnscp.io/contact.html' },
];

/** This host's own surfaces, which exist nowhere else. */
const SERVICE_NAV: readonly { id: string; label: string; href: string }[] = [
  { id: 'catalog', label: 'Catalog', href: '/profiles' },
  { id: 'workspace', label: 'Workspace', href: '/workspace' },
  { id: 'account', label: 'Account', href: '/account' },
];

let accountNav = false;
export function enableAccountNav(): void {
  accountNav = true;
}

/** The Workspace link appears only on a host that runs one beside its instance (§20.3). */
let workspaceNav = false;
export function enableWorkspaceNav(): void {
  workspaceNav = true;
}

export type NavId = 'registry' | 'catalog' | 'workspace' | 'account' | 'legal' | 'about';

function chrome(title: string, active: NavId | null, body: string): string {
  const nav = (id: string, href: string, label: string) =>
    `<li><a${active === id ? ' class="active"' : ''} href="${href}">${label}</a></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="icon" href="https://cnscp.io/favicon.ico">
<style>${SITE_STYLE}</style></head><body>
<header class="site-header"><div class="bar">
  <a class="brand" href="https://cnscp.io"><img src="https://cnscp.io/CNSCP-Square.png" alt=""><span>CNS/CP<sup class="tm">&trade;</sup></span></a>
  <nav class="site-nav" aria-label="CNS/CP"><ul>
    ${SITE_NAV.map((i) => nav(i.id, i.href, i.label)).join('\n    ')}
  </ul></nav>
  <nav class="service-nav" aria-label="Registry"><ul>
    ${SERVICE_NAV.filter((i) => (i.id !== 'account' || accountNav) && (i.id !== 'workspace' || workspaceNav))
      .map((i) => nav(i.id, i.href, i.label))
      .join('\n    ')}
  </ul></nav>
</div></header>
${body}
<footer class="site-footer"><div class="tail">
  <span>&copy; 2026 Padi Inc. CNS/CP&trade; is a trademark of Padi, Inc. &middot; Openly specified &mdash; one namespace, interoperable by design.</span>
  <span><a href="https://cnscp.io">cnscp.io</a> &middot;
    <a href="https://github.com/CNSCP/registry">Source</a> &middot;
    <a href="https://projectarete.io">Project Arete</a></span>
</div></footer>
</body></html>`;
}

/** An interior page: the chrome around one content section. */
export function page(title: string, body: string, active: NavId | null = null): string {
  return chrome(title, active, `<main><section class="section"><div class="wrap">${body}</div></section></main>`);
}

/**
 * Column widths for the attribute tables, as a share of the table. Known
 * attributes get a fixed share so every table on the page — Provider,
 * Consumer, Channels — lays out the same; Description takes what is left;
 * an attribute this map does not know gets a modest share of its own.
 */
const ATTRIBUTE_WIDTH: Record<string, number> = {
  'Name': 14,
  'Mandatory': 9,
  'Propagate': 9,
  'Default': 9,
  'Sample': 12,
  'Mode': 9,
  'Protocol': 10,
  'Provider Role': 11,
  'Consumer Role': 11,
};

/** One table of attributes, every key a column, the Name in bold, widths fixed. */
function attributeTable(keys: string[], items: Record<string, unknown>[]): string {
  const fixed = keys.filter((k) => k !== 'Description').reduce((sum, k) => sum + (ATTRIBUTE_WIDTH[k] ?? 8), 0);
  const cols = keys
    .map((k) => {
      const width = k === 'Description' ? Math.max(100 - fixed, 20) : (ATTRIBUTE_WIDTH[k] ?? 8);
      return `<col style="width:${width}%">`;
    })
    .join('');
  const head = keys.map((k) => `<th>${escape(k)}</th>`).join('');
  const rows = items
    .map(
      (item) =>
        `<tr>${keys
          .map((k) => {
            if (!(k in item)) return '<td><em>absent</em></td>';
            const cell = escape(item[k]);
            return k === 'Name' ? `<td><strong>${cell}</strong></td>` : `<td>${cell}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<table class="attrs"><colgroup>${cols}</colgroup><tr>${head}</tr>${rows}</table>`;
}

/**
 * The version switcher: every version of the name, newest first, with its
 * publication date and status — plain links, no scripts. The one being
 * viewed is marked rather than linked. When this host holds the name's
 * unpublished form (§20.3), it appears last, set apart: it is not a version.
 */
export function versionStrip(
  name: string,
  all: VersionSummary[] | undefined,
  current: number | 'unpublished',
  unpublished: UnpublishedPill | null = null,
): string {
  const pills = [...(all ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((v) => {
      const label = `v${v.version} &middot; ${escape(new Date(v.published_at).toISOString().slice(0, 10))}${
        v.status === 'deprecated' ? ' &middot; <span class="dep">deprecated</span>' : ''
      }`;
      return v.version === current
        ? `<span class="pill current">${label}</span>`
        : `<a class="pill" href="/${escape(name)}:${v.version}">${label}</a>`;
    });
  if (unpublished) {
    const label = `Unpublished${unpublished.note ? ` &middot; ${escape(unpublished.note)}` : ''}`;
    pills.push(
      current === 'unpublished'
        ? `<span class="pill current unpublished">${label}</span>`
        : `<a class="pill unpublished" href="${escape(unpublished.href)}">${label}</a>`,
    );
  }
  return pills.length === 0 ? '' : `<p class="versions">${pills.join(' ')}</p>`;
}

/**
 * The document itself — Header, Properties, Channels — every attribute of
 * every one, nothing dropped (§19.1). Shared by the version page and by the
 * workspace's page for an unpublished form (§20.3), so the two read alike
 * and neither summarizes.
 */
export function documentSections(document: {
  Header?: Record<string, unknown>;
  Properties?: Record<string, unknown[]>;
  Channels?: Record<string, unknown>[];
}): string {
  const header = document.Header ?? {};
  const properties = document.Properties ?? {};
  const channels = Array.isArray(document.Channels) ? document.Channels : [];

  // Website is a pointer (spec §6.6 NOTE); a browser should be able to follow
  // it. Only http(s) values become links — anything else is shown as text.
  const headerCell = (k: string, v: unknown): string =>
    k === 'Website' && typeof v === 'string' && /^https?:\/\//i.test(v)
      ? `<a href="${escape(v)}" target="_blank" rel="noopener noreferrer nofollow">${escape(v)}</a>`
      : escape(v);
  const headerRows = Object.entries(header)
    .map(([k, v]) => `<tr><th>${escape(k)}</th><td>${headerCell(k, v)}</td></tr>`)
    .join('');

  // Each role group is headed by the role AND the party the Header names for
  // it — "Provider (Controller)" — so the table reads as who supplies what.
  const roleHeading = (role: 'Provider' | 'Consumer'): string => {
    const party = header[role];
    return typeof party === 'string' && party.trim() !== '' ? `${role} (${escape(party)})` : role;
  };

  // Both role tables share ONE column set — the union of every attribute any
  // Property in either role carries — and fixed column widths, so Provider
  // and Consumer line up instead of each table sizing itself to its own
  // content. Every attribute of every Property, always: no column is dropped
  // for being uninteresting — that is how key-presence flags get lost.
  const propertyKeys = [
    ...new Set((['Provider', 'Consumer'] as const).flatMap((role) => ((properties[role] ?? []) as Record<string, unknown>[]).flatMap((p) => Object.keys(p)))),
  ];
  const roleTables = (['Provider', 'Consumer'] as const)
    .map((role) => {
      const list = (properties[role] ?? []) as Record<string, unknown>[];
      if (list.length === 0) return `<h3>${roleHeading(role)}</h3><p>No Properties.</p>`;
      return `<h3>${roleHeading(role)}</h3>${attributeTable(propertyKeys, list)}`;
    })
    .join('');

  // Channels (spec §6.5): shown with the same discipline as Properties —
  // every attribute of every Channel, nothing dropped. A Channel belongs to
  // no role, so it gets its own section rather than a place under either.
  // Omitted entirely when the document declares none, as most do.
  const channelTable = (() => {
    if (channels.length === 0) return '';
    const keys = [...new Set(channels.flatMap((c) => Object.keys(c)))];
    return `<h2>Channels</h2>${attributeTable(keys, channels)}
      <p class="note">A Channel is open to both roles from Bind and carries the protocol it names; where that
      protocol has roles of its own, Provider Role and Consumer Role say which Profile role plays which.
      Channels are fixed by the first published version (spec §6.5, §6.2).</p>`;
  })();

  return `<h2>Header</h2><table>${headerRows}</table>
     <h2>Properties</h2>${roleTables}
     ${channelTable}`;
}

function renderVersion(version: ResolvedVersion, all?: VersionSummary[], unpublished: UnpublishedPill | null = null): string {
  // The page presents the ANSWER (§19.1): current Status, Owner and Website
  // over the frozen content, exactly as the machine shapes answer.
  const document = presentVersion(version).document as Parameters<typeof documentSections>[0];

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
     ${versionStrip(version.name, all, version.version, unpublished)}
     ${shortfall}
     ${documentSections(document)}
     <div class="raw"><strong>The contract is the document, not this page.</strong>
       <code>GET /${escape(version.name)}:${version.version}</code>
       with <code>Accept: application/cp+json; profile=2026</code>.
       SHA-256 <code>${escape(version.content_hash)}</code>.</div>`,
  );
}

function renderVersionList(
  body: {
    name: string;
    registered: Date;
    versions: { version: number; status: string; published: Date; href: string }[];
  },
  unpublished: UnpublishedPill | null = null,
): string {
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
     ${unpublished ? versionStrip(body.name, undefined, -1, unpublished) : ''}
     ${body.versions.length === 0
       ? unpublished
         ? '<p>No published versions. The name is registered; its unpublished form is held in the workspace on this host (§20.3) — the pill above.</p>'
         : '<p>No published versions. The name is registered; its working document lives with its author (spec §7.3).</p>'
       : `<table><tr><th>Version</th><th>Status</th><th>Published</th></tr>${rows}</table>`}`,
  );
}

/** "Unpublished" in a listing — a link to the form when this host holds it (§20.3), plain text otherwise. */
function unpublishedCell(name: string, held: Map<string, UnpublishedPill>): string {
  const pill = held.get(name);
  return pill ? `<a class="pill unpublished" href="${escape(pill.href)}">Unpublished</a>` : '<em>Unpublished</em>';
}

function renderAllocation(
  body: {
    tlp: string;
    holder: string | null;
    names: { name: string; versions: { version: number; status: string }[]; href: string }[];
  },
  held: Map<string, UnpublishedPill> = new Map(),
): string {
  const rows = body.names
    .map(
      (n) =>
        `<tr><td><a href="${escape(n.href)}">${escape(n.name)}</a></td><td>${
          n.versions.length === 0 ? unpublishedCell(n.name, held) : n.versions.map((v) => v.version).join(', ')
        }${n.versions.length > 0 && held.has(n.name) ? ` &middot; ${unpublishedCell(n.name, held)}` : ''}</td></tr>`,
    )
    .join('');

  return page(
    `cp:${body.tlp}`,
    `<h1><code>cp:${escape(body.tlp)}</code></h1>
     <p>Held by ${escape(body.holder ?? 'the operator')}.</p>
     <table><tr><th>Name</th><th>Versions</th></tr>${rows}</table>`,
  );
}

/**
 * The front page. Most human visits to the canonical host land here, so it
 * is a real landing page rather than a bare table — but it stays what every
 * other page is: server-rendered, styled inline, zero scripts. The search
 * box is a plain GET form over the catalog, and works in anything.
 *
 * The look is CNSCP/web's design system (cnscp.io style.css), inlined: same
 * variables, hero treatment, buttons and footer, so the registry reads as
 * part of the same site. Kept self-contained — the only cross-host assets
 * are the brand marks, which degrade to text.
 */
function renderIndex(
  allocations: {
    tlp: string;
    holder: string | null;
    grandfathered: boolean;
    names: number;
    published_versions: number;
    published_names: number;
    unpublished_names: number;
    href: string;
  }[],
): string {
  const holdings = allocations.filter((a) => a.names > 0);
  const empty = allocations.filter((a) => a.names === 0);
  const names = allocations.reduce((sum, a) => sum + a.names, 0);
  const versions = allocations.reduce((sum, a) => sum + a.published_versions, 0);

  // Published and Unpublished count NAMES, one unit for an honest comparison:
  // a Prefix heavy with registered-but-never-published names should look it.
  const row = (a: (typeof allocations)[number]) =>
    `<tr><td><a href="${escape(a.href)}"><code>cp:${escape(a.tlp)}</code></a></td>
     <td>${escape(a.holder ?? 'the operator')}</td>
     <td class="n">${a.published_names}</td>
     <td class="n${a.unpublished_names > 0 ? ' warn' : ''}">${a.unpublished_names}</td></tr>`;

  return chrome('CP Registry — Connection Profiles by name', 'registry', `
<div class="hero"><div class="wrap">
  <span class="eyebrow">The CP Registry</span>
  <h1>Every Connection Profile, by name.</h1>
  <p class="lead">The canonical registry of <span class="mono">cp:</span> Connection Profiles —
    small, immutable contracts that systems resolve at connection time. One namespace, so every
    use of CNS/CP stays interoperable.</p>
  <form class="search-row" action="/profiles" method="get">
    <input name="q" placeholder="Search profiles — a name, a word, a purpose&hellip;" autofocus>
    <button class="btn btn-primary">Search</button>
  </form>
  <div class="stats">${allocations.length} Prefixes &middot; ${names} names &middot;
    ${versions} published versions &middot;
    ${allocations.reduce((s, a) => s + a.unpublished_names, 0)} unpublished &middot;
    <a href="/profiles">browse the full catalog</a></div>
</div></div>
<main>
<section class="section"><div class="wrap">
  <h2>Top Level Prefixes</h2>
  <p class="section-intro">Each Prefix is allocated to one holder; the names beneath it are that
    holder's Profiles. Open a Prefix to see everything registered under it.</p>
  <div class="card"><table>
    <tr><th>Prefix</th><th>Held by</th><th class="n">Published</th><th class="n">Unpublished</th></tr>
    ${holdings.map(row).join('')}
  </table></div>
  ${empty.length === 0 ? '' : `<details><summary>${empty.length} allocated Prefixes with no
  registered names (infrastructure withholdings and new allocations)</summary>
  <div class="card"><table>
    <tr><th>Prefix</th><th>Held by</th><th class="n">Published</th><th class="n">Unpublished</th></tr>
    ${empty.map(row).join('')}
  </table></div></details>`}
</div></section>
<section class="section"><div class="wrap">
  <h2>Resolving</h2>
  <p class="section-intro">A Profile resolves at the root of this host —
    no key, no account: resolution is public by specification.</p>
  <div class="callout"><span class="mono">GET /&lt;name&gt;</span> lists a name's versions
    &middot; <span class="mono">GET /&lt;name&gt;:&lt;version&gt;</span> is the immutable
    contract itself — try <a href="/padi.lighting:2"><span class="mono">cp:padi.lighting:2</span></a>.
    Machines receive <span class="mono">application/cp+json</span>; these pages are the same
    documents, rendered.</div>
</div></section>
</main>`);
}

function renderCatalog(
  body: {
    query: { q?: string; prefix?: string; limit: number; offset: number };
    total: number;
    count: number;
    entries: { name: string; title?: string; versions: { version: number; status: string }[]; href: string }[];
    next?: string;
    prev?: string;
  },
  held: Map<string, UnpublishedPill> = new Map(),
): string {
  const { q, prefix, offset } = body.query;

  const rows = body.entries
    .map(
      (e) =>
        `<tr><td><a href="${escape(e.href)}"><code>${escape(e.name)}</code></a></td>
         <td>${escape(e.title ?? '')}</td>
         <td>${
           e.versions.length === 0
             ? unpublishedCell(e.name, held)
             : e.versions.map((v) => `${v.version}${v.status === 'deprecated' ? ' (deprecated)' : ''}`).join(', ')
         }${e.versions.length > 0 && held.has(e.name) ? ` &middot; ${unpublishedCell(e.name, held)}` : ''}</td></tr>`,
    )
    .join('');

  const showing =
    body.total === 0
      ? 'No names match.'
      : `Showing ${offset + 1}–${offset + body.count} of ${body.total}.`;

  const paging = [
    body.prev ? `<a href="${escape(body.prev)}">&larr; previous</a>` : '',
    body.next ? `<a href="${escape(body.next)}">next &rarr;</a>` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return page(
    'Catalog — Connection Profile Registry',
    `<h1>Catalog</h1>
     <p class="section-intro">Every registered name, searchable across names and published
       Titles and Descriptions.</p>
     <form class="search-row" action="/profiles" method="get"><input name="q" value="${escape(q ?? '')}"
       placeholder="Search names, titles, descriptions">${
         prefix ? `<input type="hidden" name="prefix" value="${escape(prefix)}">` : ''
       } <button class="btn btn-primary">Search</button></form>
     ${prefix ? `<p>Names beginning <code>${escape(prefix)}.</code> as a string.</p>` : ''}
     <p>${showing}</p>
     ${body.count === 0 ? '' : `<div class="card"><table><tr><th>Name</th><th>Title</th><th>Versions</th></tr>${rows}</table></div>`}
     ${paging ? `<p>${paging}</p>` : ''}
     <p class="raw">A text search over registered names and published Headers. No relationship may be
     inferred between names (spec §7.7); this is not an index. <a href="/">All Prefixes</a>.</p>`,
    'catalog',
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

/** The version page renderer, exposed for tests that feed it a document directly. */
export const renderVersionForTest = renderVersion;
