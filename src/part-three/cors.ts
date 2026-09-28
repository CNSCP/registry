/**
 * Cross-origin reads of the public surface — design §19.4, Arete's finding 2.
 *
 * WHAT THIS IS. Permission for a page in a browser to READ an answer. It is
 * not a write defence: a simple cross-origin request is still sent and still
 * takes effect, and the browser merely hides the response. What protects the
 * authoring API is that it authenticates by Bearer token and never by cookie,
 * so there is no ambient authority for a page to borrow — CSRF is structurally
 * absent rather than defended against. The day an authoring path accepts a
 * cookie it needs its own story, and nothing here will supply one.
 *
 * WHY `*` RATHER THAN AN ECHOED ORIGIN. Reflecting the request's Origin says
 * the answer may depend on who asked, and obliges `Vary: Origin`, which
 * fragments every cache in front of the Registry for no gain. `*` says the
 * opposite, which is the true thing: one name and version is one answer, to
 * everyone. No `Allow-Credentials`, ever — incompatible with `*`, and the read
 * surface takes no credential.
 *
 * THE LIST IS DELIBERATE. Routes are enumerated rather than matched loosely,
 * so that a route added later is private until someone decides otherwise. The
 * one path wildcard is `/profiles/…`, which is a wildcard in the path only:
 * every request under it goes to the same resolver as `/:ref`.
 */

import type { FastifyInstance } from 'fastify';

/**
 * Headers a cross-origin reader may see. Without this a browser gets the body
 * and almost nothing else — no validator to revalidate with, no digest to
 * check, no way to learn the answer is deprecated.
 *
 * `content-digest` detects corruption in transit. It does NOT establish that
 * canon authored the bytes: whoever controls the response controls the digest.
 * Provenance is the signed anchor's (§20.2), which is why `/.well-known/…` is
 * in the list below.
 */
export const EXPOSE_HEADERS = [
  'etag',
  'content-digest',
  'x-cp-status',
  'x-cp-grandfathered',
  'x-cp-surface',
  'deprecation',
  'sunset',
  'link',
].join(', ');

/** Read methods. `HEAD` is a cheap `GET`; `OPTIONS` is how a preflight asks. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const PUBLIC_EXACT = new Set([
  '/',
  '/health',
  '/profiles',
  '/references/parse',
  '/policy/prefixes',
  '/distribution/snapshot',
  '/distribution/journal',
  '/distribution/status',
  // The audit surface. A browser-based verifier can check integrity without
  // these and provenance only with them.
  '/.well-known/cp-anchor',
  '/.well-known/cp-keys',
]);

const PUBLIC_PREFIXES = ['/profiles/', '/policy/prefixes/', '/allocations/'];

/**
 * The identity surface belongs to one origin.
 *
 * `/account` is a STATIC route that collides with the `/:ref` catch-all.
 * Fastify resolves static before parametric so it reaches its own handler —
 * but this check must exclude it BY NAME rather than rely on that ordering,
 * because the test here is on the path, not on which route matched.
 */
function isIdentity(path: string): boolean {
  return path === '/account' || path === '/auth' || path.startsWith('/auth/');
}

/** Is this path part of the public read surface? */
export function isPublicRead(path: string): boolean {
  const at = path.indexOf('?');
  const clean = at === -1 ? path : path.slice(0, at);
  if (isIdentity(clean)) return false;
  if (PUBLIC_EXACT.has(clean)) return true;
  if (PUBLIC_PREFIXES.some((p) => clean.startsWith(p))) return true;

  // Resolution: `/<ref>` and `/<ref>/registration`. A reference is one path
  // segment — a Profile name or a Prefix, with or without `:<version>`.
  const segments = clean.split('/').filter((s) => s.length > 0);
  if (segments.length === 1) return true;
  if (segments.length === 2 && segments[1] === 'registration') return true;
  return false;
}

/**
 * Mark every public read with the two headers, and answer preflight.
 *
 * The hook runs on the way out, so it covers the responses a browser actually
 * meets and not only the happy path: a `304` from a revalidation, a `404` on
 * an unknown name, the `406` on a Channel-bearing legacy fetch. An error a
 * browser cannot read is an error it cannot report.
 */
export function registerCors(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!READ_METHODS.has(request.method)) return payload;
    if (!isPublicRead(request.url)) return payload;
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-expose-headers', EXPOSE_HEADERS);
    return payload;
  });

  // A plain GET for a Profile needs no preflight — `Accept` is CORS-safelisted
  // even with our media type. `If-None-Match` is NOT safelisted, so the FIRST
  // request a caching client makes succeeds and every revalidation after it is
  // preflighted: without this, a browser client works until it starts caching
  // properly and then stops.
  const preflight = async (path: string, reply: Parameters<Parameters<FastifyInstance['options']>[1]>[1]) => {
    if (!isPublicRead(path)) return reply.code(404).send({ error: 'not found' });
    return reply
      .header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
      .header('access-control-allow-headers', 'Accept, If-None-Match, If-Modified-Since')
      .header('access-control-max-age', '86400')
      .code(204)
      .send();
  };

  app.options('/', async (request, reply) => preflight(request.url, reply));
  app.options('/*', async (request, reply) => preflight(request.url, reply));
}
