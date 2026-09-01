/**
 * The bootstrap — design §10.
 *
 * Eighteen de-facto Prefixes exist on cp.padi.io holding 70 records. Spec §7.1
 * grandfathers them as allocated, but not to anyone in particular. §10.2 says
 * to whom. This file is that ruling as data, and it is the input to the import;
 * every row here becomes an `allocation` and an audit event with its rationale
 * recorded, so the bootstrap is as inspectable as anything that follows it.
 *
 * Inventory taken 31 August 2026.
 */

export type Disposition =
  /** Allocated to the operator organization as an ordinary holding. */
  | 'operator'
  /** Operator-held, released to the named claimant on verification (§8.1). Ruling 4. */
  | 'pending-claimant'
  /** Operator-held and withheld from reallocation (§3.2). Rulings 2 and 3. */
  | 'withheld'
  /** Spec-reserved: no allocation row is created at all (spec §7.1). Ruling 1. */
  | 'spec-reserved';

export type SeedPrefix = {
  readonly tlp: string;
  readonly disposition: Disposition;
  /** Records observed beneath it on cp.padi.io. */
  readonly records: number;
  /** The organization evident from the records' `company` field. */
  readonly evidentAuthor: string;
  /** Named publicly on the allocation page where disposition is pending-claimant. */
  readonly pendingClaimant?: string;
  readonly claimantWebsite?: string;
  readonly closedToRegistration?: boolean;
  readonly rationale: string;
};

export const OPERATOR_ORG = {
  name: 'Padi, Inc.',
  website: 'https://padi.io',
  contactEmail: 'registry@padi.io',
} as const;

export const GRANDFATHERED: readonly SeedPrefix[] = [
  // --- The operator's own (§10.2 ruling 3 for `hello`; the rest ordinary) ---
  {
    tlp: 'padi',
    disposition: 'operator',
    records: 27,
    evidentAuthor: 'Padi, Inc.',
    rationale: "The operator's own Prefix. Largest holding in the namespace.",
  },
  {
    tlp: 'cns',
    disposition: 'operator',
    records: 3,
    evidentAuthor: 'Padi, Inc.',
    rationale:
      "Padi-authored infrastructure Profiles (cns.broker, cns.helm, cns.kube). Note `cns` is also on the withheld infrastructure list in §3.2 — it is allocated to the operator, which is what withholding means in practice.",
  },
  {
    tlp: 'haystack',
    disposition: 'operator',
    records: 2,
    evidentAuthor: 'Padi, Inc.',
    rationale: 'Padi-authored. Project Haystack has an evident interest; no claim recorded at import.',
  },
  {
    tlp: 'dbp',
    disposition: 'operator',
    records: 1,
    evidentAuthor: 'Padi, Inc.',
    rationale: 'Padi-authored (dbp.fact.basic).',
  },
  {
    tlp: 'kube',
    disposition: 'operator',
    records: 1,
    evidentAuthor: 'Padi, Inc.',
    rationale: 'Padi-authored (kube.cns). Distinct from `kubecns`, which is Tacos Linux.',
  },
  {
    tlp: 'modbus',
    disposition: 'operator',
    records: 1,
    evidentAuthor: 'Padi, Inc.',
    rationale: 'Padi-authored (modbus.basic). A protocol name held by the operator; revisit if a body claims it.',
  },
  {
    tlp: 'hello',
    disposition: 'operator',
    records: 1,
    evidentAuthor: 'Padi, Inc.',
    rationale: "Padi's own demo record (hello.world). §10.2 ruling 3.",
  },

  // --- Real external claimants: operator-held, released on verification -----
  // §10.2 ruling 4. Nothing is claimed on anyone's behalf; the allocation
  // record is truthful from the first day, and the claimant is named publicly
  // so a third party cannot race the Prefix.
  {
    tlp: 'onuma',
    disposition: 'pending-claimant',
    records: 6,
    evidentAuthor: 'ONUMA',
    pendingClaimant: 'ONUMA',
    claimantWebsite: 'https://onuma.com',
    rationale: 'Six records authored by ONUMA. Released on verification under §8.1.',
  },
  {
    tlp: 'ibb',
    disposition: 'pending-claimant',
    records: 3,
    evidentAuthor: 'IBB Project',
    pendingClaimant: 'IBB Project',
    rationale:
      'Three records authored by the IBB Project. Reserved for them pending verification — but note the obstacle: the only website on record is a Google Doc, and §8.1 verification is a DNS or well-known challenge against a domain. The claimant must supply a contactable domain before this Prefix can be released. Reviewed and confirmed 31 Aug 2026.',
  },
  {
    tlp: 'kubecns',
    disposition: 'pending-claimant',
    records: 2,
    evidentAuthor: 'Tacos Linux',
    pendingClaimant: 'Tacos Linux',
    claimantWebsite: 'https://tacoslinux.com',
    rationale: 'kubecns.control is Tacos Linux; kubecns.application carries no company and is titled "Not in use".',
  },
  {
    tlp: 'skycentrics',
    disposition: 'pending-claimant',
    records: 2,
    evidentAuthor: 'SkyCentrics, Inc.',
    pendingClaimant: 'SkyCentrics, Inc.',
    rationale:
      'Two records authored by SkyCentrics, Inc. Reserved for them pending verification — but note the obstacle: both websites on record are Google Docs, and §8.1 verification is a DNS or well-known challenge against a domain. The claimant must supply a contactable domain before this Prefix can be released. Reviewed and confirmed 31 Aug 2026.',
  },
  {
    tlp: 'c4sb',
    disposition: 'pending-claimant',
    records: 1,
    evidentAuthor: 'C4SB',
    pendingClaimant: 'C4SB',
    claimantWebsite: 'https://c4sb.org',
    rationale: 'c4sb.idl.proto, authored by C4SB with a real domain. A straightforward §8.1 verification.',
  },
  {
    tlp: 'novant',
    disposition: 'pending-claimant',
    records: 1,
    evidentAuthor: 'Novant.io',
    claimantWebsite: 'https://novant.io',
    pendingClaimant: 'Novant.io',
    rationale: 'The oldest record in the namespace (April 2021), authored by Novant.io.',
  },
  {
    tlp: 'openjs',
    disposition: 'pending-claimant',
    records: 1,
    evidentAuthor: 'The OpenJS Foundation',
    pendingClaimant: 'The OpenJS Foundation',
    claimantWebsite: 'https://nodered.org',
    rationale: 'openjs.nodered, authored by the OpenJS Foundation.',
  },

  // --- Withheld ------------------------------------------------------------
  {
    tlp: 'proto',
    disposition: 'withheld',
    records: 14,
    evidentAuthor: 'Padi, ControlBEAM, Digital Twin Consortium, Jitsuin',
    closedToRegistration: true,
    rationale:
      'Shared legacy Prefix. Fourteen sub-names import unchanged so existing prototypes keep resolving; the bare single-segment `proto` record is DROPPED because spec §7.2 forbids registering a one-segment reference as a Profile. Not allocated to the operator, because its contents come from four unrelated organizations. Closed to new registration: the shared-Prefix pattern is the sandbox v0.3 removed. §10.2 ruling 2.',
  },
  {
    tlp: 'acme',
    disposition: 'withheld',
    records: 2,
    evidentAuthor: 'Acme Corp (fictional)',
    closedToRegistration: true,
    rationale:
      'Conventional fake-company name serving the same purpose as spec-reserved `example`. Withheld so it can never be allocated to a real party and be misread. §10.2 ruling 3.',
  },
  {
    tlp: 'xyz',
    disposition: 'withheld',
    records: 1,
    evidentAuthor: 'XYZ Systems, Inc. (fictional)',
    closedToRegistration: true,
    rationale:
      'Fake-company name; xyz.ics cites www.example.com as its website. Withheld alongside `acme`. §10.2 ruling 3.',
  },

  // --- Spec-reserved: no allocation row exists -----------------------------
  {
    tlp: 'test',
    disposition: 'spec-reserved',
    records: 1,
    evidentAuthor: 'Padi, Inc.',
    rationale:
      'Spec-reserved and never globally resolvable (spec §7.1). Its sole record, test.abc, is republished as padi.test.abc under an existing Padi convention; test.abc stops resolving. No allocation row is created, and none ever may be. §10.2 ruling 1.',
  },
] as const;

/**
 * Names that must NOT be imported as Profiles, with the reason.
 *
 * Kept beside the Prefix dispositions because an importer that reads one and
 * not the other would silently reintroduce them.
 */
export const IMPORT_EXCLUSIONS: readonly { readonly name: string; readonly reason: string }[] = [
  {
    name: 'proto',
    reason:
      'A one-segment reference denotes an allocation and is never a Profile; the Registry SHALL NOT register it as one (spec §7.2). §10.2 ruling 2.',
  },
  {
    name: 'test.abc',
    reason:
      '`test` is spec-reserved and never globally resolvable (spec §7.1). Republished as padi.test.abc. §10.2 ruling 1.',
  },
] as const;

/** Names republished under a different Prefix at import. */
export const IMPORT_RENAMES: readonly { readonly from: string; readonly to: string; readonly reason: string }[] = [
  {
    from: 'test.abc',
    to: 'padi.test.abc',
    reason:
      "Padi already uses padi.test.* for exactly this purpose, so the record lands in an established convention rather than a new exception. The record is Padi's own, so no third party's contract is broken. §10.2 ruling 1.",
  },
] as const;

export const EXPECTED_RECORD_COUNT = 70;
