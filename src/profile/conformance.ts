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
 * `Version` and `Pub Date` are exempt for a Draft: spec §6.4 says of both that
 * "the Draft carries none". A Draft is not thereby a conforming *published*
 * Profile — it is not a contract at all (§6.2) — so absence of those two is
 * only excused when Status actually says Draft.
 */
export function missingHeaderFields(profile: Profile): HeaderField[] {
  const isDraft = profile.status === 'Draft';

  const present: Record<HeaderField, boolean> = {
    'Name': profile.name !== undefined && profile.name !== '',
    'Version': isDraft || profile.version !== undefined,
    'Pub Date': isDraft || profile.pubDate !== undefined,
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
 * Spec §6.3: "A Property's name SHALL be unique within its Profile, across
 * both roles." Across BOTH roles — a `uri` supplied by the Provider and a
 * `uri` supplied by the Consumer is a violation, not two namespaces.
 */
export function duplicatePropertyNames(version: ProfileVersion): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const property of version.properties) {
    if (seen.has(property.name)) duplicates.add(property.name);
    seen.add(property.name);
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

  // §9.4: "carries every REQUIRED Header field (§6.4)".
  for (const field of missingHeaderFields(profile)) {
    findings.push({
      kind: 'missing-header-field',
      field,
      detail: `Header field "${field}" is REQUIRED (§6.4) and absent`,
    });
  }

  const version = (profile.versions ?? [])[versionIndex];
  if (version) {
    for (const name of duplicatePropertyNames(version)) {
      findings.push({
        kind: 'duplicate-property-name',
        property: name,
        detail: `"${name}" appears more than once; names are unique across BOTH roles (§6.3)`,
      });
    }

    if (options.requireSample) {
      for (const property of version.properties) {
        if (property.sample === undefined) {
          findings.push({
            kind: 'missing-property-attribute',
            property: property.name,
            attribute: 'Sample',
            detail: `Property "${property.name}" carries no Sample (§6.3)`,
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
