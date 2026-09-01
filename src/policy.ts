/**
 * Reserved and withheld Top Level Prefixes — design §3.2, spec §7.1.
 *
 * The distinction matters and is not cosmetic:
 *
 *   RESERVED  the specification reserves exactly two, and both SHALL NOT be
 *             allocated, ever, by anyone. Not this operator's decision to make
 *             and not this operator's to revoke.
 *
 *   WITHHELD  this operator's policy choice under spec §7.1, which permits the
 *             allocation function to withhold Prefixes. A withheld Prefix is
 *             HELD BY THE OPERATOR, so nothing beneath it is ownerless, and it
 *             may be released later by a recorded decision.
 *
 * Both lists are published (§9.2) so that a refusal is knowable in advance.
 */

export type ReservedRule = {
  readonly tlp: string;
  readonly rule: string;
};

/** Spec §7.1, following RFC 2606. Exactly two, and neither is negotiable. */
export const SPEC_RESERVED: readonly ReservedRule[] = [
  {
    tlp: 'example',
    rule:
      'Documentation only. Every Profile named in the specification and its training material lives here; nothing under it resolves.',
  },
  {
    tlp: 'test',
    rule:
      'Local exercise; never globally resolvable. Unrelated to the Draft state — `test` is a place in the namespace, Draft is a stage in a Profile lifecycle.',
  },
] as const;

export type WithheldClass = 'infrastructure' | 'path-shadowing' | 'documentary' | 'operator-held';

export type WithheldRule = {
  readonly tlp: string;
  readonly class: WithheldClass;
  readonly rationale: string;
};

/**
 * Operator policy. Grouped by why, because the reasons have different
 * lifetimes: infrastructure names are withheld indefinitely, path-shadowing
 * entries are withheld only as long as the corresponding path is reserved, and
 * operator-held entries are real holdings that could in principle move.
 */
export const WITHHELD: readonly WithheldRule[] = [
  // Reserved against future infrastructure naming and confusion with reference syntax.
  ...(['cp', 'cns', 'realm', 'arete', 'registry', 'registrar', 'local', 'internal'] as const).map(
    (tlp) =>
      ({
        tlp,
        class: 'infrastructure',
        rationale: 'Reserved against future infrastructure naming and confusion with reference syntax.',
      }) as const,
  ),

  // A single dotless segment resolves to the allocation it denotes (§19.1), so
  // every reserved path must ALSO be a withheld Prefix or it would be shadowed.
  // These two lists must be extended together — see RESERVED_PATHS below.
  ...(['console', 'assets', 'profiles', 'distribution', 'health', 'well-known'] as const).map(
    (tlp) =>
      ({
        tlp,
        class: 'path-shadowing',
        rationale:
          'A reserved path on cp. would be shadowed by an allocation of the same name (§19.1). Extend with RESERVED_PATHS.',
      }) as const,
  ),

  // v0.5 ruling 3 (§10.2). Conventional fake-company names serving the same
  // purpose as spec-reserved `example`. `xyz.ics` cites www.example.com as its
  // website. Withheld so neither can later be allocated to a real party and be
  // misread as that party's own.
  {
    tlp: 'acme',
    class: 'documentary',
    rationale: 'Conventional fake-company name; demo records only. §10.2 ruling 3.',
  },
  {
    tlp: 'xyz',
    class: 'documentary',
    rationale: 'Conventional fake-company name; its sole record cites www.example.com. §10.2 ruling 3.',
  },

  // Operator holdings that are withheld from reallocation rather than merely owned.
  {
    tlp: 'padi',
    class: 'operator-held',
    rationale: "The operator's own Prefix, 27 grandfathered records.",
  },
  {
    tlp: 'hello',
    class: 'operator-held',
    rationale: "The operator's own Prefix. §10.2 ruling 3.",
  },
  // v0.5 ruling 2 (§10.2). NOT allocated to the operator as a normal holding:
  // its 14 records come from four unrelated organizations, and allocating it
  // would make the operator the owner of Digital Twin Consortium and Jitsuin
  // content. Withheld is the honest description. Closed to new registration —
  // the shared-Prefix pattern is the sandbox v0.3 removed.
  {
    tlp: 'proto',
    class: 'operator-held',
    rationale:
      'Shared legacy Prefix holding records from four unrelated organizations. Closed to new registration; no successor offered. §10.2 ruling 2.',
  },
] as const;

/**
 * Dotless paths on `cp.` (design §4.4). Routing is decided by one rule: does
 * the first path segment contain a dot? A dot means resolution; no dot means
 * console, API, or infrastructure. Kept beside WITHHELD because the two lists
 * must move together.
 */
export const RESERVED_PATHS: readonly string[] = [
  'console',
  'assets',
  'profiles',
  'distribution',
  'health',
  '.well-known',
] as const;

/** Restricted: allocatable, but only on reviewer approval with recorded rationale (§8.2). */
export function isRestricted(tlp: string, trademarkWatchList: readonly string[] = []): boolean {
  if (tlp.length === 1) return true;
  return trademarkWatchList.includes(tlp);
}

const RESERVED_SET = new Set(SPEC_RESERVED.map((r) => r.tlp));
const WITHHELD_MAP = new Map(WITHHELD.map((w) => [w.tlp, w]));

export function isSpecReserved(tlp: string): boolean {
  return RESERVED_SET.has(tlp);
}

export function isWithheld(tlp: string): boolean {
  return WITHHELD_MAP.has(tlp);
}

export type Availability =
  | { available: true }
  | { available: false; because: 'spec-reserved'; rule: string }
  | { available: false; because: 'withheld'; class: WithheldClass; rationale: string }
  | { available: false; because: 'restricted'; rationale: string };

/**
 * May this Prefix be allocated?
 *
 * Answers only the policy question. Whether it is already *held* is a separate
 * question for the allocation table — a Prefix can be perfectly allocatable in
 * policy and simply taken.
 */
export function availability(tlp: string, trademarkWatchList: readonly string[] = []): Availability {
  const reserved = SPEC_RESERVED.find((r) => r.tlp === tlp);
  if (reserved) return { available: false, because: 'spec-reserved', rule: reserved.rule };

  const withheld = WITHHELD_MAP.get(tlp);
  if (withheld) {
    return { available: false, because: 'withheld', class: withheld.class, rationale: withheld.rationale };
  }

  if (isRestricted(tlp, trademarkWatchList)) {
    return {
      available: false,
      because: 'restricted',
      rationale:
        tlp.length === 1
          ? 'Single-character Prefixes are allocatable only on reviewer approval with recorded rationale (§8.2).'
          : 'On the published trademark watch list; allocatable only on reviewer approval (§8.2).',
    };
  }

  return { available: true };
}
