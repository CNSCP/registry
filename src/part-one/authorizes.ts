/**
 * THE SEAM — design §4.1, §9.3.
 *
 *   authorizes(actor, name) → { allowed, allocation_id, reason }
 *
 * This is the ONE question Part Two asks Part One, and the only synchronous
 * coupling between them. It is spec §7.3's requirement stated as a function:
 * the Registry must check that an authorization exists, while the specification
 * deliberately declines to define its form.
 *
 * Three disciplines hold this module in place.
 *
 * 1. IT IS A WRITE-PATH CHECK ONLY. Nothing here may ever be consulted when
 *    resolving a published version. A suspended organization, a locked
 *    allocation, a dispute in flight — none of it may affect resolution, which
 *    spec §9.3 answers to any party regardless of what has become of an
 *    author. §4.1 rule 1 calls this easy to violate accidentally with a naive
 *    join, and it is: the moment a resolution query reaches this file, the
 *    Registry is non-conforming.
 *
 * 2. IT IS PURE OVER AN INJECTED STORE. No pool, no config, no clock of its
 *    own. The whole ownership chain lives in one testable place (§23), and the
 *    tests exercise it without a database.
 *
 * 3. A BROKEN LINK DENIES. Every step is an explicit narrowing with a named
 *    reason; there is no path to `allowed: true` that skips one.
 */

import { nameProblem, tlpOf, scopeCovers } from '../names.ts';
import { isSpecReserved, isWithheld } from '../policy.ts';
import type { Actor, Allocation, OwnershipStore } from './types.ts';

export type Intent =
  /** Register a new name beneath the Prefix, or create/modify its Draft. */
  | 'register'
  /**
   * Publish a version on a name already registered. Same ownership chain, but
   * the allocation's own state is NOT a gate — §14 puts allocation state under
   * Registration and lists only content gates under Publication, and a steward
   * hold "cannot alter, unpublish, or refuse to serve anything already
   * published". See `allocationBlocksRegistration`.
   */
  | 'publish';

export type DenyReason =
  | 'name-malformed'
  | 'name-single-segment'
  | 'prefix-spec-reserved'
  | 'allocation-not-found'
  | 'allocation-not-active'
  | 'allocation-closed-to-registration'
  | 'holder-org-not-active'
  | 'no-membership'
  | 'no-covering-scope'
  | 'scope-not-active'
  | 'scope-expired'
  | 'grantee-org-not-active';

export type AllowReason = 'holder-member' | 'authorization-scope';

export type Decision =
  | {
      allowed: true;
      reason: AllowReason;
      allocation_id: string;
      tlp: string;
      /** Set when the decision came from a scope grant rather than membership. */
      authorization_id?: string;
      detail: string;
    }
  | {
      allowed: false;
      reason: DenyReason;
      allocation_id: string | null;
      tlp: string | null;
      detail: string;
    };

export type AuthorizesOptions = {
  intent?: Intent;
  /** Injected for testability; defaults to now. Used only for scope expiry. */
  now?: Date;
};

function deny(
  reason: DenyReason,
  detail: string,
  tlp: string | null = null,
  allocation_id: string | null = null,
): Decision {
  return { allowed: false, reason, detail, tlp, allocation_id };
}

/**
 * Allocation-state gates — REGISTRATION ONLY.
 *
 * §14 lists the Registry's grounds for refusal, and the split is a conformance
 * question rather than a preference. Allocation state appears there under
 * Registration ("Prefix is allocated…", "Prefix is not reserved or withheld");
 * the Publication rows are content gates only — additivity, required Header
 * fields, Property attributes. §7.2 says a steward hold "suspends transfer and
 * *new registration*", and §14 repeats it: the hold "suspends new registration
 * under that Prefix. It cannot alter, unpublish, or refuse to serve anything
 * already published."
 *
 * So a locked or closed allocation stops new NAMES appearing beneath it, and
 * does not stop a version being published on a name already registered there.
 * Refusing publication on this ground would be refusing on a ground the
 * specification does not state, which spec §9.3 forbids.
 *
 * The ownership chain still applies to publication in full — spec §7.3 requires
 * the authorization to exist for both acts. Only the allocation's own state is
 * waived here.
 */
function allocationBlocksRegistration(allocation: Allocation): Decision | null {
  if (allocation.status !== 'active') {
    // `locked` is a dispute hold; `redemption` and `released` are lapsed;
    // `requested`/`reserved` are not yet in force. Published versions beneath
    // any of them keep resolving — decided elsewhere, and deliberately not
    // here (see discipline 1).
    return deny(
      'allocation-not-active',
      `allocation "${allocation.tlp}" has status "${allocation.status}"; only an active allocation admits registration of new names`,
      allocation.tlp,
      allocation.id,
    );
  }

  if (allocation.closed_to_registration) {
    // §10.2 ruling 2: `proto` holds records from four unrelated organizations
    // and is closed. Its existing names keep working; nothing new joins them.
    return deny(
      'allocation-closed-to-registration',
      `allocation "${allocation.tlp}" is closed to registration of new names; its existing names continue to resolve, and versions may still be published on them`,
      allocation.tlp,
      allocation.id,
    );
  }

  return null;
}

/**
 * An organization in good enough standing to act.
 *
 * `suspended` freezes management writes (§7.1); `dissolved` sends its
 * allocations into redemption; `applied` has not been verified at all. Both
 * `active` and `verified` may act — §7.1 makes `verified` the state between
 * verification and a first allocation, and a member of a verified organization
 * that holds a Prefix by transfer has done nothing wrong.
 */
function orgMayAct(org: { status: string } | null): boolean {
  return org !== null && (org.status === 'active' || org.status === 'verified');
}

/**
 * Resolve the whole chain: actor → organization membership → allocation of the
 * name's Prefix, or an authorization scope covering the name → allocation
 * status is active.
 */
export async function authorizes(
  store: OwnershipStore,
  actor: Actor,
  name: string,
  options: AuthorizesOptions = {},
): Promise<Decision> {
  const intent: Intent = options.intent ?? 'register';
  const now = options.now ?? new Date();

  // --- The name itself ------------------------------------------------------

  const problem = nameProblem(name);
  if (problem === 'single-segment') {
    // Spec §7.2: a one-segment reference denotes an allocation and is never a
    // Profile; the Registry SHALL NOT register it as one. Its own reason,
    // because it is not a typo — it is a category error, and the refusal
    // message should say so.
    return deny(
      'name-single-segment',
      `"${name}" has one segment; it denotes an allocation, and the Registry may not register it as a Profile (spec §7.2)`,
    );
  }
  if (problem) {
    return deny('name-malformed', `"${name}" is not a well-formed Profile name (${problem})`);
  }

  const tlp = tlpOf(name);

  // --- Policy ---------------------------------------------------------------

  if (isSpecReserved(tlp)) {
    // `example` and `test` SHALL NOT be allocated (spec §7.1), so no
    // authorization beneath them can exist for anyone to check.
    return deny(
      'prefix-spec-reserved',
      `"${tlp}" is reserved by the specification and is never allocated (spec §7.1), so nothing beneath it may be registered`,
      tlp,
    );
  }
  // A withheld Prefix is NOT refused here. Withheld means held by the operator
  // (§3.2), so it has a real allocation row and the ordinary chain applies —
  // operator staff can act beneath it, and nobody else can. Refusing on the
  // withheld list would deny the operator its own Prefixes.

  // --- The allocation -------------------------------------------------------

  const allocation = await store.allocationByTlp(tlp);
  if (!allocation) {
    return deny('allocation-not-found', `no allocation exists for Prefix "${tlp}"`, tlp);
  }

  if (intent === 'register') {
    const blocked = allocationBlocksRegistration(allocation);
    if (blocked) return blocked;
  }

  // --- The holder organization must be in good standing, on EVERY path ------
  //
  // Checked before the branch, not inside one. A suspended owner's grantee must
  // not keep writing beneath a Prefix whose management writes are frozen —
  // suspension does not change allocation status, so nothing else would catch
  // it, and putting this check inside the membership branch (as it was) left
  // exactly that hole open on the scope path.

  const holder = await store.organizationById(allocation.org_id);
  if (!orgMayAct(holder)) {
    return deny(
      'holder-org-not-active',
      `the organization holding "${tlp}" has status "${holder?.status ?? 'missing'}"; management writes beneath it are frozen (§7.1)`,
      tlp,
      allocation.id,
    );
  }

  // --- Path A: the actor is a member of the holding organization ------------

  const memberships = await store.membershipsOfUser(actor.userId);
  const holderMembership = memberships.find((m) => m.org_id === allocation.org_id);

  if (holderMembership) {
    // Membership is itself authorization to act under the Prefix (§5). Small
    // owners need nothing more.
    //
    // §5 also says "unless the owner has narrowed it with scopes" — there is no
    // narrowing mechanism in §6.4 to implement, so membership is currently
    // unconditional. See §25 Q7.
    return {
      allowed: true,
      reason: 'holder-member',
      allocation_id: allocation.id,
      tlp,
      detail: `${actor.userId} is a ${holderMembership.role} of the organization holding "${tlp}"`,
    };
  }

  // --- Path B: an authorization scope covering the name ---------------------

  const grants = await store.authorizationsForAllocation(allocation.id);
  const actorOrgs = new Set(memberships.map((m) => m.org_id));

  // Consider only grants to an organization this actor belongs to, and only
  // those whose scope covers the name. Scope is a string prefix, not a tree.
  const covering = grants.filter((g) => actorOrgs.has(g.grantee_org_id) && scopeCovers(g.scope, name));

  if (covering.length === 0) {
    return deny(
      'no-covering-scope',
      `${actor.userId} is not a member of the organization holding "${tlp}", and no authorization scope granted to their organizations covers "${name}"`,
      tlp,
      allocation.id,
    );
  }

  // Scopes may not overlap (§8.3), so at most one should cover the name. If the
  // data ever disagrees with that rule, prefer the most specific.
  covering.sort((a, b) => b.scope.length - a.scope.length);

  // Look for a scope that is USABLE, rather than taking the most specific and
  // then testing it. Otherwise an expired long scope masks a perfectly good
  // shorter one: the answer would still be a denial, but the wrong denial, and
  // an owner debugging it would be sent to the wrong record.
  for (const candidate of covering) {
    if (candidate.status !== 'active') continue;
    if (candidate.expires_at && candidate.expires_at <= now) continue;

    const grantee = await store.organizationById(candidate.grantee_org_id);
    if (!orgMayAct(grantee)) continue;

    return {
      allowed: true,
      reason: 'authorization-scope',
      allocation_id: allocation.id,
      tlp,
      authorization_id: candidate.id,
      detail: `authorization scope "${candidate.scope}" covers "${name}"`,
    };
  }

  // Nothing usable. Report on the most specific covering scope, which is the
  // one whose owner is most likely to be looking for an explanation.
  const best = covering[0]!;

  if (best.status !== 'active') {
    return deny(
      'scope-not-active',
      `authorization scope "${best.scope}" covering "${name}" has status "${best.status}"; ` +
        (best.status === 'offered'
          ? 'it must be accepted before it authorizes anything'
          : 'it no longer authorizes anything'),
      tlp,
      allocation.id,
    );
  }

  if (best.expires_at && best.expires_at <= now) {
    return deny(
      'scope-expired',
      `authorization scope "${best.scope}" expired at ${best.expires_at.toISOString()}`,
      tlp,
      allocation.id,
    );
  }

  const grantee = await store.organizationById(best.grantee_org_id);
  return deny(
    'grantee-org-not-active',
    `the organization granted scope "${best.scope}" has status "${grantee?.status ?? 'missing'}"`,
    tlp,
    allocation.id,
  );
}
