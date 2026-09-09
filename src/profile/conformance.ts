/**
 * §9.4 — a conforming Connection Profile.
 *
 * This is a REPORT, not a gate. Spec §9.3 is explicit that "the grounds on
 * which a Registry may refuse are those this specification states, and no
 * others", and §14 of the design lists which of these are Registry gates at
 * publication (Header completeness, Property attributes, unique names) versus
 * owner-side policy. So this module answers "does this document conform?" and
 * leaves "may it be published?" to the caller.
 *
 * It exists chiefly because of what the deployed corpus turned out to be.
 * Measured over all 70 records on 31 August 2026:
 *
 *   - 38 of 70 can fill the six REQUIRED Header fields the legacy format
 *     carries at all (Owner, Title, Provider, Consumer, Description, Website)
 *   - `Pub Date` and `Status` have NO legacy source — `approved` and `active`
 *     are null in every record
 *   - 0 of 303 Properties carry a Sample
 *
 * Which means no deployed record can be imported as a conforming Profile
 * without data that does not exist. That is a decision for the import policy,
 * not something a mapper should quietly resolve — see §25 Q11.
 */

import type { Profile, ProfileVersion } from './model.ts';
import { nameProblem } from '../names.ts';
import { isSpecReserved } from '../policy.ts';

/** Spec §6.4 — all ten are REQUIRED. */
export const REQUIRED_HEADER_FIELDS = [
  'Name',
  'Version',
  'Pub Date',
  'Status',
  'Owner',
  'Title',
  'Provider',
  'Consumer',
  'Description',
  'Website',
] as const;

export type HeaderField = (typeof REQUIRED_HEADER_FIELDS)[number];

export type ConformanceFinding =
  | { kind: 'missing-header-field'; field: HeaderField; detail: string }
  | { kind: 'missing-property-attribute'; property: string; attribute: string; detail: string }
  | { kind: 'duplicate-property-name'; property: string; detail: string }
  | { kind: 'no-properties'; detail: string }
  | { kind: 'channel-invalid'; channel: string; detail: string }
  | { kind: 'name-invalid'; detail: string }
  | { kind: 'prefix-reserved'; detail: string };

export type ConformanceReport = {
  name: string;
  conforms: boolean;
  findings: ConformanceFinding[];
};

/**
 * Which REQUIRED Header fields does this Profile lack?
 *
 * `Version` and `Pub Date` are exempt while Unpublished: both are assigned at
 * publication (spec §6.2, §6.6), so an unpublished form cannot carry them.
 * §9.4 makes the same point from the other side: "an Unpublished Profile is a
 * registered name whose content has not yet been checked, and it claims
 * nothing" — this function's verdict on one is advisory, never a conformance
 * claim.
 */
export function missingHeaderFields(profile: Profile): HeaderField[] {
  const isUnpublished = profile.status === 'Unpublished';

  const present: Record<HeaderField, boolean> = {
    'Name': profile.name !== undefined && profile.name !== '',
    'Version': isUnpublished || profile.version !== undefined,
    'Pub Date': isUnpublished || profile.pubDate !== undefined,
    'Status': profile.status !== undefined,
    'Owner': profile.owner !== undefined,
    'Title': profile.title !== undefined,
    'Provider': profile.providerTitle !== undefined,
    'Consumer': profile.consumerTitle !== undefined,
    'Description': profile.description !== undefined,
    'Website': profile.website !== undefined,
  };

  return REQUIRED_HEADER_FIELDS.filter((f) => !present[f]);
}

/**
 * Spec §6.4 (8 Sept revision): "A Property's name SHALL be unique within its
 * Profile, across both roles AND AMONG THE PROFILE'S CHANNELS: Properties and
 * Channels share one name space" — because a Node addresses what a Connection
 * carries by name, whichever kind of thing it is.
 */
export function duplicatePropertyNames(version: ProfileVersion): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const property of version.properties) {
    if (seen.has(property.name)) duplicates.add(property.name);
    seen.add(property.name);
  }
  for (const channel of version.channels ?? []) {
    if (seen.has(channel.name)) duplicates.add(channel.name);
    seen.add(channel.name);
  }
  return [...duplicates];
}

export type CheckOptions = {
  /**
   * Treat a missing Sample as a finding.
   *
   * Spec §6.3 says each Property "carries the attributes Name, Mandatory,
   * Propagate, Description, and Sample", and §9.4 requires "the attributes
   * §6.3 requires" — so on the strict reading Sample is required. But §6.3
   * also says Description and Sample "are documentary… this specification
   * takes no view of them", which is read by some as making an empty Sample
   * sufficient and its absence a formatting matter rather than a conformance
   * one. The two readings differ for all 303 deployed Properties, so the
   * choice is exposed rather than made here. See §25 Q11.
   */
  requireSample?: boolean;
};

export function checkProfileVersion(
  profile: Profile,
  versionIndex = 0,
  options: CheckOptions = {},
): ConformanceReport {
  const findings: ConformanceFinding[] = [];

  // §9.4: "bears a registered name of two or more segments, lowercase, under
  // an allocated Top Level Prefix (§7.2, §7.3)".
  const problem = nameProblem(profile.name);
  if (problem) {
    findings.push({ kind: 'name-invalid', detail: `"${profile.name}" is not a valid Profile name (${problem})` });
  } else {
    const tlp = profile.name.slice(0, profile.name.indexOf('.'));
    if (isSpecReserved(tlp)) {
      findings.push({
        kind: 'prefix-reserved',
        detail: `"${tlp}" is reserved by the specification and is never allocated (§7.1)`,
      });
    }
  }

  // §9.4: "carries every REQUIRED Header field (§6.6)".
  for (const field of missingHeaderFields(profile)) {
    findings.push({
      kind: 'missing-header-field',
      field,
      detail: `Header field "${field}" is REQUIRED (§6.6) and absent`,
    });
  }

  const version = (profile.versions ?? [])[versionIndex];
  if (version) {
    // §9.4 (8 Sept revision): "has at least one Property … whether or not it
    // declares Channels". A Channel alone would give the Governor nothing to
    // see and the counterpart nothing to read before the Channel carries.
    if (version.properties.length === 0) {
      findings.push({
        kind: 'no-properties',
        detail:
          'A Profile consists of one or more named Properties (§6.4, §9.4); a Connection must be observable through its Properties even when Channels carry the traffic',
      });
    }

    for (const name of duplicatePropertyNames(version)) {
      findings.push({
        kind: 'duplicate-property-name',
        property: name,
        detail: `"${name}" appears more than once; Properties and Channels share one name space (§6.4, §6.5)`,
      });
    }

    // §9.4: each Channel with the attributes §6.5 requires, and no latency or
    // throughput declared. Mode/Protocol/Description presence is enforced by
    // the parser; what remains checkable here is the performance-claim ban.
    for (const channel of version.channels ?? []) {
      const text = `${channel.description} ${channel.protocol}`.toLowerCase();
      if (/\b(latency|throughput)\s*[:=<>]?\s*\d/.test(text)) {
        findings.push({
          kind: 'channel-invalid',
          channel: channel.name,
          detail: `Channel "${channel.name}" appears to declare latency or throughput; those are properties of a deployment, not terms of a contract (§6.5)`,
        });
      }
    }

    if (options.requireSample) {
      for (const property of version.properties) {
        if (property.sample === undefined) {
          findings.push({
            kind: 'missing-property-attribute',
            property: property.name,
            attribute: 'Sample',
            detail: `Property "${property.name}" carries no Sample (§6.4)`,
          });
        }
      }
    }
  }

  return { name: profile.name, conforms: findings.length === 0, findings };
}

/** Summarize a corpus — what an import report should show before it runs. */
export function summarize(reports: ConformanceReport[]): {
  total: number;
  conforming: number;
  byMissingField: Record<string, number>;
} {
  const byMissingField: Record<string, number> = {};
  let conforming = 0;

  for (const report of reports) {
    if (report.conforms) conforming++;
    for (const finding of report.findings) {
      const key = finding.kind === 'missing-header-field' ? `Header.${finding.field}` : finding.kind;
      byMissingField[key] = (byMissingField[key] ?? 0) + 1;
    }
  }

  return { total: reports.length, conforming, byMissingField };
}
