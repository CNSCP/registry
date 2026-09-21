/**
 * Forwarding — design §20.3, §4.4.
 *
 * §4.4 has an instance answer a write with `405` and the authoritative host's
 * URL. An instance configured as a forwarder relays it instead: the caller's
 * request, with the caller's own credential, to the authoritative host, and
 * the answer back verbatim.
 *
 * WHAT THIS IS FOR. An organization running a workspace beside its instance
 * (§20.3) wants one URL for its tools: drafts and acts at the same host. It
 * matters most inside a security boundary, where the internal host is
 * deliberately the only thing that talks to canon, and every tool inside
 * points at it.
 *
 * IT RELAYS; IT DOES NOT DECIDE. That sentence is the whole security
 * argument, and each clause of it is enforced here rather than promised:
 *
 *   - The host holds NO canon credential. It has nothing of its own to send,
 *     so it can act for nobody. What it relays is the bearer the caller
 *     presented; canon checks scope and the seam exactly as it always does,
 *     and the journal names the caller's principal exactly as it always does.
 *     Nothing about who may publish changes because a request went through
 *     this host.
 *   - It refuses nothing of its own. Every response is the upstream's status
 *     and body, unread. A forwarder that could refuse an act canon would
 *     accept would make an organization's authors dependent on their host —
 *     the §5.3 capture this design exists to avoid (§20.3, ground 4).
 *   - It keeps nothing. The credential is read from one header and written to
 *     one header; it is never logged, never stored, and the relayed body is
 *     never copied anywhere.
 *   - Canon is always reachable directly. Any caller can make the same call
 *     to the authoritative host and compare, which is what makes the three
 *     promises above checkable rather than trusted.
 *
 * WHAT IS NEVER FORWARDED. Only a Profile path — a first path segment
 * containing a dot (§4.4's one routing rule). That excludes `/operator/*`
 * (the operator's own plane, rare and better done at canon), `/auth/*` and
 * `/account` (which belong to canon's own origin, where the session cookie
 * is), and everything else dotless. `:unpublished` never reaches here: it is
 * the workspace's, and the workspace is not a Registry surface.
 *
 * And there is no combined act — no `PUT /<name>` with a body that registers
 * at canon and saves the draft in one request. It would be a second way into
 * the workspace authorized by a different credential. A client makes the two
 * calls; the server keeps one credential per surface.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { instanceRefusal } from './routes.ts';

/** Handles one non-GET on this instance: relays it, or refuses it with the authoritative host's URL. */
export type WriteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;

export type ForwarderOptions = {
  /** Origin of the authoritative host. */
  upstream: string;
  /** Injectable for tests; the real one is global fetch. */
  fetch?: typeof globalThis.fetch;
  /** How long to wait on the authoritative host before giving up. */
  timeoutMs?: number;
};

/**
 * Headers that describe THIS connection rather than the message, and must not
 * be copied onto another one. `content-length` and `content-encoding` go too:
 * the body is re-sent, and the serving framework sets the length itself.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'host',
]);

/** A dotted first path segment is a Profile name (§4.4); everything else is this host's own. */
export function isProfilePath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  const first = path.replace(/^\/+/, '').split('/')[0] ?? '';
  return first.includes('.');
}

export function createForwarder(options: ForwarderOptions): WriteHandler {
  const upstream = options.upstream.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async function forward(request, reply) {
    // Not a Profile path: this host has no business relaying it, and §4.4's
    // answer — go to the authoritative host — is the right one.
    if (!isProfilePath(request.url)) return instanceRefusal(reply, upstream);

    const headers: Record<string, string> = {};
    for (const name of ['authorization', 'content-type', 'accept', 'if-match', 'idempotency-key']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    const body =
      request.body === undefined || request.body === null
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);

    let response: Response;
    try {
      response = await doFetch(`${upstream}${request.url}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The act did not happen — or this host cannot tell whether it did,
      // which for an irreversible act is the same thing to say out loud.
      // Either way the caller can make the same call at the authoritative
      // host, so the answer names it.
      return reply
        .code(502)
        .header('cache-control', 'no-store')
        .header('x-cp-forwarded-to', upstream)
        .send({
          code: 'forward.unreachable',
          gate: 'forward',
          kind: 'forward-refusal',
          message:
            `This host relays writes to ${upstream} and could not reach it (${(error as Error).message}). ` +
            'Nothing here refused your act, and nothing here recorded it: make the same call at the authoritative host, ' +
            'and check there whether it had already taken effect before retrying anything irreversible.',
          authoritative: upstream,
        });
    }

    for (const [name, value] of response.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) reply.header(name, value);
    }
    reply.header('x-cp-forwarded-to', upstream);

    const text = await response.text();
    reply.code(response.status);
    // Verbatim: the upstream's bytes, with its own content type. Nothing is
    // parsed, because nothing here is entitled to an opinion about it.
    return reply.send(text.length === 0 ? null : text);
  };
}

/**
 * The non-GET fallthrough for an instance: refuse with the authoritative
 * host's URL (§4.4), or relay (§20.3). Registered after every route that
 * owns a write of its own — the workspace's `:unpublished` — so those keep
 * their handlers.
 */
export function registerWriteFallthrough(app: FastifyInstance, handler: WriteHandler): void {
  for (const url of ['/', '/*']) {
    app.route({ method: ['PUT', 'POST', 'PATCH', 'DELETE'], url, handler });
  }
}
