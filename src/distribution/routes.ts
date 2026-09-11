/**
 * The distribution routes — design §20, §20.1. Part of the RESOLUTION
 * PROFILE (§4.4): the authoritative host and every instance serve them, and
 * the shapes are additive-only from here on (§21).
 *
 *   GET /distribution/snapshot   bootstrap: everything published, at one instant
 *   GET /distribution/journal    follow:    the audit chain, projected, from a cursor
 *   GET /distribution/status     where this host stands
 */

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { JOURNAL_FORMAT } from './journal.ts';
import { chainHead, instanceState, journalFromAudit, journalFromCopy, snapshot, type Role } from './store.ts';

export type DistributionDeps = {
  pool: pg.Pool;
  role: Role;
  /** Origin of the authoritative host; required for an instance. */
  upstream?: string;
};

export const JOURNAL_DEFAULT_LIMIT = 200;
export const JOURNAL_MAX_LIMIT = 1000;

export async function registerDistributionRoutes(app: FastifyInstance, deps: DistributionDeps): Promise<void> {
  const { pool, role } = deps;

  app.get('/distribution/snapshot', async (_request, reply) => {
    const body = await snapshot(pool, role);
    // A snapshot is a moment; the next one differs. Never cached.
    return reply.header('cache-control', 'no-cache').send(body);
  });

  app.get<{ Querystring: { since?: string; limit?: string } }>('/distribution/journal', async (request, reply) => {
    const since = request.query.since === undefined ? 0 : Number(request.query.since);
    const limit = request.query.limit === undefined ? JOURNAL_DEFAULT_LIMIT : Number(request.query.limit);
    if (!Number.isInteger(since) || since < 0) {
      return reply.code(400).send({ error: 'since is a non-negative integer: the last seq you hold' });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > JOURNAL_MAX_LIMIT) {
      return reply.code(400).send({ error: `limit is an integer from 1 to ${JOURNAL_MAX_LIMIT}` });
    }

    const page = role === 'instance' ? await journalFromCopy(pool, since, limit) : await journalFromAudit(pool, since, limit);
    if ('error' in page) {
      return reply.code(416).header('cache-control', 'no-cache').send({
        error: `this instance holds the journal from seq ${page.earliest_seq}; for earlier entries ask the authoritative host`,
        earliest_seq: page.earliest_seq,
        ...(deps.upstream ? { authoritative: deps.upstream } : {}),
      });
    }

    // A full page is a fixed slice of an append-only chain and carries no
    // moving part (the head is omitted while `more` is true), so it may be
    // cached for as long as anyone likes. The page that reached the head
    // changes with the next act.
    reply.header('cache-control', page.more ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(page);
  });

  app.get('/distribution/status', async (_request, reply) => {
    reply.header('cache-control', 'no-cache');
    if (role === 'authoritative') {
      return reply.send({
        role,
        journal_format: JOURNAL_FORMAT,
        head: await chainHead(pool, role),
        // The signed anchor of §4.3 is not yet published (§20.1).
        anchor: null,
      });
    }

    const state = await instanceState(pool);
    const now = Date.now();
    return reply.send({
      role,
      journal_format: JOURNAL_FORMAT,
      upstream: state?.upstream ?? deps.upstream ?? null,
      bootstrapped: state !== null,
      cursor: state ? { seq: state.cursor_seq, event_hash: state.head_hash } : null,
      head: state ? { seq: state.cursor_seq, event_hash: state.head_hash } : null,
      upstream_head_seq: state?.upstream_head_seq ?? null,
      behind: state?.upstream_head_seq === null || state?.upstream_head_seq === undefined ? null : state.upstream_head_seq - state.cursor_seq,
      last_sync_at: state?.last_sync_at ?? null,
      lag_seconds: state?.last_sync_at ? Math.round((now - state.last_sync_at.getTime()) / 1000) : null,
      last_error: state?.last_error ?? null,
      last_error_at: state?.last_error_at ?? null,
      anchor: null,
      anchor_verified: null,
    });
  });
}

/**
 * §4.4: "a write to a local instance returns the authoritative host's URL".
 * An instance mounts no authoring route, so the absence is the enforcement;
 * this makes the refusal say where to go instead of a bare 404.
 */
export function registerInstanceRefusals(app: FastifyInstance, upstream: string): void {
  for (const url of ['/', '/*']) {
    app.route({
      method: ['PUT', 'POST', 'PATCH', 'DELETE'],
      url,
      handler: async (_request, reply) =>
        reply.code(405).header('allow', 'GET, HEAD').send({
          error: 'this is a resolution-only instance; writes go to the authoritative host',
          authoritative: upstream,
        }),
    });
  }
}
