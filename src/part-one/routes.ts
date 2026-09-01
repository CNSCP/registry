/**
 * Part One HTTP surface — a subset of §9.1, plus the seam.
 *
 * The spine serves what the ownership graph can answer today. The workflow
 * endpoints of §9.1 and the whole operator plane of §9.2 wait for Phase 2
 * (§10.3), and are deliberately absent rather than stubbed: a route that
 * returns 501 invites a client to be written against it.
 *
 * §9.2 has a standing absence worth restating here, because it is enforced by
 * the same means — there is no endpoint anywhere to alter, unpublish, or
 * withhold a published version. Spec §9.3 forbids all three, so the capability
 * should not exist in the codebase. Its absence is the enforcement.
 */

import type { FastifyInstance } from 'fastify';
import { authorizes } from './authorizes.ts';
import type { ActorKind, OwnershipStore } from './types.ts';
import { availability, SPEC_RESERVED, WITHHELD } from '../policy.ts';
import { isTlp, parseReference } from '../names.ts';

export type RoutesDeps = {
  store: OwnershipStore;
  /**
   * Bearer token Part Two presents to call the seam.
   *
   * Required. §4.4: "Machine clients use bearer tokens exclusively." The seam
   * takes the actor's identity from the request body — it is Part Two's job to
   * have authenticated that person — so an unauthenticated seam is not merely
   * an information leak, it is an authorization bypass for anyone who can
   * reach the port. There is deliberately no default and no dev-mode escape.
   */
  internalToken: string;
};

import { timingSafeEqual } from 'node:crypto';

export async function registerPartOneRoutes(app: FastifyInstance, deps: RoutesDeps): Promise<void> {
  const { store, internalToken } = deps;

  if (!internalToken || internalToken.length < 32) {
    throw new Error(
      'registerPartOneRoutes: internalToken must be at least 32 characters. The seam authorizes writes; it is not optional.',
    );
  }

  const expected = Buffer.from(internalToken);

  function presentedValidToken(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    // Length must match before timingSafeEqual, and comparing lengths early
    // leaks only the length, which is not the secret.
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  app.get('/health', async () => ({ ok: true, part: 'one', surface: 'allocation' }));

  /**
   * Published policy (§9.2). Read-only in the spine — the lists are code, and
   * changing them is a reviewed commit rather than an API call, which is the
   * right weight for a decision that changes what the Registry will refuse.
   */
  app.get('/policy/prefixes', async () => ({
    spec_reserved: SPEC_RESERVED,
    withheld: WITHHELD,
    note: 'Spec-reserved Prefixes SHALL NOT be allocated by anyone (spec §7.1). Withheld Prefixes are this operator’s policy and are held by the operator.',
  }));

  app.get<{ Params: { tlp: string } }>('/policy/prefixes/:tlp', async (request, reply) => {
    const { tlp } = request.params;
    if (!isTlp(tlp)) {
      return reply.code(400).send({ error: 'not a well-formed Top Level Prefix' });
    }
    return { tlp, ...availability(tlp) };
  });

  /**
   * Public allocation lookup (§9.1). Holder and status, nothing more.
   *
   * Note what is not returned: no membership list, no authorization scopes, no
   * verification evidence. Who holds a Prefix is public; who may act under it
   * is the holder's business.
   */
  app.get<{ Params: { tlp: string } }>('/allocations/:tlp', async (request, reply) => {
    const { tlp } = request.params;
    if (!isTlp(tlp)) {
      return reply.code(400).send({ error: 'not a well-formed Top Level Prefix' });
    }

    const allocation = await store.allocationByTlp(tlp);
    if (!allocation) {
      const policy = availability(tlp);
      return reply.code(404).send({
        tlp,
        allocated: false,
        ...(policy.available ? {} : { policy }),
      });
    }

    const holder = await store.organizationById(allocation.org_id);

    return {
      reference: `cp:${tlp}`,
      tlp,
      allocated: true,
      status: allocation.status,
      class: allocation.class,
      grandfathered: allocation.grandfathered,
      closed_to_registration: allocation.closed_to_registration,
      holder: holder ? { name: holder.name, website: holder.website, is_operator: holder.is_operator } : null,
      // §10.2 ruling 4: naming the evident claimant publicly is what stops a
      // third party racing a Prefix that is plainly spoken for, without
      // asserting an ownership nobody has verified.
      pending_claimant: allocation.pending_claimant,
      notes: allocation.notes,
    };
  });

  /** Parse a reference. Useful to clients, and keeps one grammar in one place. */
  app.get<{ Querystring: { ref?: string } }>('/references/parse', async (request, reply) => {
    const ref = request.query.ref;
    if (!ref) return reply.code(400).send({ error: 'missing ?ref=' });
    try {
      return { input: ref, parsed: parseReference(ref) };
    } catch (error) {
      return reply.code(400).send({ input: ref, error: (error as Error).message });
    }
  });

  /**
   * THE SEAM (§9.3). Internal — Part Two calls this and nothing else.
   *
   * Exposed over HTTP so the two parts can be deployed separately later without
   * Part Two changing. In a single-process deployment, call `authorizes()`
   * directly; the function is the interface, this route is one transport.
   */
  app.post<{ Body: { actor?: { userId?: string; kind?: string; principal?: string }; name?: string; intent?: string } }>(
    '/internal/authorizes',
    async (request, reply) => {
      if (!presentedValidToken(request.headers.authorization)) {
        return reply.code(401).send({ error: 'the seam requires a bearer token (§4.4)' });
      }

      const { actor, name, intent } = request.body ?? {};
      if (typeof name !== 'string' || typeof actor?.userId !== 'string' || !actor.userId || !name) {
        return reply
          .code(400)
          .send({ error: 'body requires { actor: { userId: string }, name: string }' });
      }
      if (intent !== undefined && intent !== 'register' && intent !== 'publish') {
        return reply.code(400).send({ error: 'intent must be "register" or "publish"' });
      }

      const decision = await authorizes(
        store,
        { userId: actor.userId, kind: (actor.kind as ActorKind) ?? 'human', principal: actor.principal },
        name,
        intent === undefined ? {} : { intent },
      );

      // Always 200: a denial is a successful answer to the question asked.
      return decision;
    },
  );
}
