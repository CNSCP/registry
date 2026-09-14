/**
 * Contract lint — design §16, built 14 September 2026.
 *
 * Lint is a function of one document and, where a check needs it, the versions
 * already published under that name. It touches no credential, no membership
 * and no allocation, which is what lets an author run it before they have any
 * authority at all.
 *
 * It never refuses. Publication has exactly the grounds §14 and spec §9.3
 * name, and lint adds none: a document with twelve findings publishes if it is
 * conformant, and a document with none is refused if it is not additive. Two
 * of the checks report what the gate will do anyway — `header.incomplete` and
 * `version.additivity` — and those carry `gate: true`, so the author sees in
 * one list both what will be refused and what is merely unwise. The rest are
 * advice, and the Registry's own answer does not change because of them.
 *
 * Every check here cites a clause of the specification or an irreversibility
 * in this Registry. A check that can cite neither is house style, and house
 * style imposed by a registry is how a substrate stops being one.
 */

import type { Profile, ProfileVersion, Property } from './model.ts';
import { checkProfileVersion } from './conformance.ts';
import { checkAdditivityAgainstAll } from './additivity.ts';

export type Severity = 'refusal' | 'warning' | 'note';

export type LintCheck =
  | 'header.incomplete'
  | 'profile.malformed'
  | 'property.direction-prefix'
  | 'property.duplicate'
  | 'profile.non-capture'
  | 'channel.performance-claim'
  | 'version.additivity'
  | 'version.permanence';

export type Finding = {
  check: LintCheck;
  severity: Severity;
  /** A path into the document: `Header.Owner`, `Properties[3].Name`. */
  where: string;
  message: string;
  /** The clause the check rests on. */
  spec: string;
  /** Present only where the finding is also a publication refusal ground. */
  gate?: true;
};

export type LintContext = {
  /** Versions already published under this name, for additivity and permanence. */
  priors?: { version: number; content: ProfileVersion }[];
};

/**
 * Role markers as name prefixes. The supplying role is structural — each
 * Property declares it — so encoding it in the name is redundant at best and
 * wrong at worst, since the name survives a Property whose role was corrected
 * before first publication. Underscore-delimited only: `input_pressure` is a
 * quantity, not a direction, and must not trip this.
 */
const DIRECTION_PREFIXES = ['in', 'out', 'tx', 'rx', 'send', 'recv', 'server', 'client'] as const;

function directionPrefix(name: string): string | null {
  const lower = name.toLowerCase();
  for (const prefix of DIRECTION_PREFIXES) {
    if (lower.startsWith(`${prefix}_`)) return prefix;
  }
  return null;
}

/**
 * Spec §5.3: a Profile is a contract between counterparts and does not
 * condition its enactment on any named Governor or Realm; §6.7: realm policy
 * is not part of a Profile. Both are §9.4 conformance requirements, and
 * neither is a Registry refusal ground — the Registry does not read prose for
 * meaning, so this is a warning that asks a person to look.
 *
 * Conservative by construction: it fires only where one of the two nouns
 * appears alongside language of restriction, which is what capture reads like.
 */
const CAPTURE_NOUN = /\b(governor|realm)\b/i;
const CAPTURE_MODAL = /\b(only|must|shall|require[sd]?|restricted to|limited to|approved by|authorised by|authorized by)\b/i;

function capturesEnactment(text: string | undefined): boolean {
  if (!text) return false;
  return CAPTURE_NOUN.test(text) && CAPTURE_MODAL.test(text);
}

export function lint(profile: Profile, context: LintContext = {}): Finding[] {
  const findings: Finding[] = [];
  const priors = context.priors ?? [];
  const version: ProfileVersion | undefined = (profile.versions ?? [])[0];

  // --- What the gate will say, reported here so it is seen in one list ------

  // A candidate is judged as the Registry judges it at publication: Version,
  // Pub Date and Status are the Registry's to assign (§6.6, §7.3), so a
  // document that omits them is not incomplete — it is correctly unpublished.
  const candidate: Profile = { ...profile, status: 'Unpublished' };

  const conformance = checkProfileVersion(candidate, 0);
  for (const f of conformance.findings) {
    if (f.kind === 'missing-header-field' && (f.field === 'Version' || f.field === 'Pub Date' || f.field === 'Status')) {
      continue;
    }
    switch (f.kind) {
      case 'missing-header-field':
        findings.push({
          check: 'header.incomplete',
          severity: 'refusal',
          where: `Header.${f.field}`,
          message: `${f.detail}. Publication is refused without it.`,
          spec: '§6.6',
          gate: true,
        });
        break;
      case 'name-invalid':
      case 'prefix-reserved':
        findings.push({
          check: 'profile.malformed',
          severity: 'refusal',
          where: 'Header.Name',
          message: f.detail,
          spec: '§7.2',
          gate: true,
        });
        break;
      case 'duplicate-property-name':
        findings.push({
          check: 'property.duplicate',
          severity: 'refusal',
          where: `Properties(${f.property})`,
          message: f.detail,
          spec: '§6.4',
          gate: true,
        });
        break;
      case 'no-properties':
        findings.push({
          check: 'profile.malformed',
          severity: 'refusal',
          where: 'Properties',
          message: f.detail,
          spec: '§9.4',
          gate: true,
        });
        break;
      case 'channel-invalid':
        findings.push({
          check: 'channel.performance-claim',
          severity: 'warning',
          where: `Channels(${f.channel})`,
          message: f.detail,
          spec: '§6.5',
        });
        break;
      case 'missing-property-attribute':
        findings.push({
          check: 'profile.malformed',
          severity: 'note',
          where: `Properties(${f.property}).${f.attribute}`,
          message: f.detail,
          spec: '§6.4',
        });
        break;
    }
  }

  if (version) {
    const additivity = checkAdditivityAgainstAll(version, priors);
    for (const f of additivity.findings) {
      findings.push({
        check: 'version.additivity',
        severity: 'refusal',
        where: 'property' in f ? `Properties(${f.property})` : `Channels(${f.channel})`,
        message: f.message,
        spec: '§6.2',
        gate: true,
      });
    }

    // --- Advice ------------------------------------------------------------

    version.properties.forEach((property: Property, index: number) => {
      const prefix = directionPrefix(property.name);
      if (prefix) {
        findings.push({
          check: 'property.direction-prefix',
          severity: 'warning',
          where: `Properties[${index}].Name`,
          message:
            `"${property.name}" begins with "${prefix}_", which names a direction. Each Property already declares which role supplies it, ` +
            `so the prefix is redundant where it agrees and misleading where it does not. Name the Property for what it carries.`,
          spec: '§6.3',
        });
      }

      if (capturesEnactment(property.description)) {
        findings.push({
          check: 'profile.non-capture',
          severity: 'warning',
          where: `Properties[${index}].Description`,
          message:
            `This Description appears to condition the Property on a named Governor or Realm. A Profile is a contract between ` +
            `counterparts and does not name who may enact it, and realm policy is not part of a Profile — check the wording.`,
          spec: '§5.3, §6.7',
        });
      }
    });

    for (const [field, text] of [
      ['Description', profile.description],
      ['Title', profile.title],
    ] as const) {
      if (capturesEnactment(text)) {
        findings.push({
          check: 'profile.non-capture',
          severity: 'warning',
          where: `Header.${field}`,
          message:
            `This ${field} appears to condition the Profile on a named Governor or Realm. A Profile that can only be enacted in one ` +
            `party's realm is that party's product, not a contract others can hold — check the wording.`,
          spec: '§5.3',
        });
      }
    }

    // The permanence note. It fires on every addition, not only suspicious
    // ones: the point is the pause, not the detection. A human author reads
    // spec §6.2's NOTE once and remembers it; a machine generating twenty
    // Properties does not.
    if (priors.length > 0) {
      const known = new Set(priors.flatMap((p) => p.content.properties.map((x) => x.name)));
      version.properties.forEach((property: Property, index: number) => {
        if (!known.has(property.name)) {
          findings.push({
            check: 'version.permanence',
            severity: 'note',
            where: `Properties[${index}].Name`,
            message:
              `"${property.name}" is new in this version. Once published under this name it can never be removed or redefined, ` +
              `in this version or any later one — this is the decision that cannot be revisited.`,
            spec: '§6.2',
          });
        }
      });
    } else {
      findings.push({
        check: 'version.permanence',
        severity: 'note',
        where: 'Properties',
        message:
          `This is the first published version of ${profile.name}. All ${version.properties.length} ` +
          `${version.properties.length === 1 ? 'Property is' : 'Properties are'} permanent from publication: later versions may add, ` +
          `but may never remove or redefine what this one establishes.`,
        spec: '§6.2',
      });
    }
  }

  return findings;
}

/** Counts by severity, for a caller that wants a one-line summary. Not a score. */
export function tally(findings: readonly Finding[]): Record<Severity, number> {
  return {
    refusal: findings.filter((f) => f.severity === 'refusal').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    note: findings.filter((f) => f.severity === 'note').length,
  };
}
