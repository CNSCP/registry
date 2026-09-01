/**
 * The Phase 0 import policy — design §10.4.
 *
 * Real Connections bind against the deployed records, so they must keep
 * resolving through the import. That decides everything else: they cannot be
 * imported as Drafts (spec §7.3 makes a Draft unanswerable to remote
 * inquiries), and the 32 records that cannot fill their Header cannot be held
 * back. Meanwhile a published version's content is frozen and immutable
 * forever (spec §6.2), so anything invented here is invented permanently.
 *
 * THE RULE THIS MODULE ENFORCES: **the Registry does not author what it
 * imports.** Where the source has a value, it is carried. Where it does not,
 * the gap is RECORDED — never filled with a plausible-looking substitute. A
 * synthesized `Owner` would be a false statement about who is responsible for
 * a contract, and it would be false permanently.
 *
 * Three gaps do have honest answers and are resolved:
 *
 *   Version   array position; spec §6.2 makes assignment the Registry's job
 *   Status    Published; they are in service, which is what Published means
 *   Pub Date  the record's `created` date, MARKED APPROXIMATE — the legacy
 *             format has no publication date, and `created` is the nearest
 *             true thing rather than the right thing
 *
 * The remedy for the rest belongs to the owner and is available immediately:
 * a Draft persists alongside published versions (spec §6.2), so any owner can
 * complete their Header and publish a conforming version 2 whenever they like.
 */

import type { Profile, ProfileVersion } from './model.ts';
import { checkProfileVersion, missingHeaderFields, type HeaderField } from './conformance.ts';
import { nameProblem } from '../names.ts';
import { isSpecReserved } from '../policy.ts';

/** One version of one record, as it will be published. */
export type ImportedVersion = {
  /** The name this version will be published under. */
  name: string;
  /**
   * The name it was served under on cp.padi.io.
   *
   * Differs from `name` only for the §10.2 ruling 1 rename. Carried because an
   * audit trail that cannot say where an imported record came from is not an
   * audit trail — and because `test.abc` is the one case where the published
   * name is not the name anyone will search the old namespace for.
   */
  sourceName: string;
  version: number;
  profile: Profile;
  content: ProfileVersion;

  /** True for everything in this import (spec §7.1 grandfathering). */
  grandfathered: true;

  /**
   * `Pub Date` is the legacy `created` timestamp, which is when the record
   * appeared and not when it was published. Recorded so the imprecision is
   * visible on the version's page rather than implied by a confident date.
   */
  pubDateIsApproximate: boolean;

  /** REQUIRED Header fields (§6.4) the source could not supply. Published, not filled. */
  missingHeaderFields: HeaderField[];

  /** Whether this version meets §9.4 once the import policy is applied. */
  conforms: boolean;
};

export type ImportDecision =
  | { action: 'import'; name: string; versions: ImportedVersion[] }
  | { action: 'exclude'; name: string; reason: string }
  | { action: 'rename'; from: string; to: string; reason: string; versions: ImportedVersion[] };

/**
 * A record with no version content still gets its NAME.
 *
 * Two deployed records — `padi.appliance` and `padi.device` — carry no
 * `versions` key at all. Dropping them would release names that are in the
 * namespace today, and §12.1 is explicit that this state is legitimate: "a row
 * with zero published versions is a registered name with a Draft and nothing
 * else — which is exactly what the Registry reports." Spec §7.3 agrees, making
 * registration date a public fact independent of publication.
 *
 * So they are registered and publish nothing. The importer must not confuse
 * "has no content to publish" with "should not exist".
 */
export function hasNoVersionContent(decision: ImportDecision): boolean {
  return decision.action !== 'exclude' && decision.versions.length === 0;
}

/**
 * Apply the §10.2 rulings and the §10.4 policy to one deployed record.
 *
 * Exclusions and the rename come first, because a record that must not be
 * imported should never be assigned a version number.
 */
export function planRecord(source: Profile): ImportDecision {
  // §10.2 ruling 2. Spec §7.2: a one-segment reference denotes an allocation
  // and is never a Profile. Checked against the grammar rather than a name
  // list, so it holds for anything else shaped this way.
  if (nameProblem(source.name) === 'single-segment') {
    return {
      action: 'exclude',
      name: source.name,
      reason:
        'A one-segment reference denotes an allocation and is never a Profile; the Registry SHALL NOT register it as one (spec §7.2). §10.2 ruling 2.',
    };
  }

  const tlp = source.name.slice(0, source.name.indexOf('.'));

  // §10.2 ruling 1. `test` is spec-reserved and never globally resolvable.
  if (isSpecReserved(tlp)) {
    if (source.name === 'test.abc') {
      const renamed: Profile = { ...source, name: 'padi.test.abc' };
      return {
        action: 'rename',
        from: source.name,
        to: 'padi.test.abc',
        versions: planVersions(renamed, source.name),
        reason:
          'Padi already uses padi.test.* for this purpose, so the record lands in an established convention rather than a new exception. The record is the operator’s own, so no third party’s contract breaks. §10.2 ruling 1.',
      };
    }
    return {
      action: 'exclude',
      name: source.name,
      reason: `"${tlp}" is reserved by the specification and is never allocated (spec §7.1).`,
    };
  }

  return { action: 'import', name: source.name, versions: planVersions(source) };
}

function planVersions(source: Profile, sourceName = source.name): ImportedVersion[] {
  const versions = source.versions ?? [];

  return versions.map((content, index) => {
    // Spec §6.2: the first publication receives 1, and each subsequent one the
    // next integer. Array position is the only ordering the source provides.
    const version = index + 1;

    // The nearest true date. `modified` is preferred for versions after the
    // first, where the source distinguishes them at all; both are approximate,
    // and the flag below says so either way.
    const pubDate = (index === 0 ? source.created : source.modified ?? source.created) ?? undefined;

    const profile: Profile = {
      ...source,
      version,
      status: 'Published',
      versions: [content],
    };
    if (pubDate !== undefined) profile.pubDate = pubDate;

    // Sample is lenient by settled reading (§25 Q11): spec §6.3 takes no view
    // of it, so its absence is a formatting matter and not a finding.
    const report = checkProfileVersion(profile, 0, { requireSample: false });

    return {
      name: source.name,
      sourceName,
      version,
      profile,
      content,
      grandfathered: true,
      pubDateIsApproximate: pubDate !== undefined,
      missingHeaderFields: missingHeaderFields(profile),
      conforms: report.conforms,
    };
  });
}

export type ImportPlan = {
  decisions: ImportDecision[];
  /** Every name that will exist in the namespace after the import. */
  registeredNames: string[];
  imported: ImportedVersion[];
  /** Registered, but with nothing to publish — legitimate per §12.1. */
  registeredWithoutVersions: string[];
  excluded: { name: string; reason: string }[];
  renamed: { from: string; to: string }[];
  conforming: number;
  nonConforming: number;
  /**
   * Distinct NAMES with a fully complete Header, as against `conforming`,
   * which counts VERSIONS. They differ: `padi.game.presence` has a complete
   * Header and two versions, so it contributes two conforming versions and one
   * conforming name. Both numbers are true and neither substitutes for the
   * other — reporting versions as names would overstate the namespace.
   */
  conformingNames: number;
  /** How many versions lack each REQUIRED Header field, published as-is. */
  shortfalls: Record<string, number>;
};

export function planImport(corpus: Profile[]): ImportPlan {
  const decisions = corpus.map(planRecord);
  const imported: ImportedVersion[] = [];
  const excluded: { name: string; reason: string }[] = [];
  const renamed: { from: string; to: string }[] = [];
  const registeredNames: string[] = [];
  const registeredWithoutVersions: string[] = [];

  for (const decision of decisions) {
    if (decision.action === 'exclude') {
      excluded.push({ name: decision.name, reason: decision.reason });
      continue;
    }

    const name = decision.action === 'rename' ? decision.to : decision.name;
    registeredNames.push(name);
    if (decision.action === 'rename') renamed.push({ from: decision.from, to: decision.to });

    if (decision.versions.length === 0) registeredWithoutVersions.push(name);
    imported.push(...decision.versions);
  }

  const shortfalls: Record<string, number> = {};
  for (const version of imported) {
    for (const field of version.missingHeaderFields) {
      shortfalls[field] = (shortfalls[field] ?? 0) + 1;
    }
  }

  return {
    decisions,
    registeredNames,
    imported,
    registeredWithoutVersions,
    excluded,
    renamed,
    conforming: imported.filter((v) => v.conforms).length,
    nonConforming: imported.filter((v) => !v.conforms).length,
    conformingNames: new Set(imported.filter((v) => v.conforms).map((v) => v.profile.name)).size,
    shortfalls,
  };
}
