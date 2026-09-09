/**
 * The additivity gate — spec §6.2, design §13.4, §23 testing priority 2.
 *
 *   "A new version SHALL NOT remove or redefine any Property of a prior
 *    version, and every Property it adds SHALL be optional."
 *
 * This is a condition on PUBLICATION, not on the Draft: it constrains what the
 * Draft may contain at the moment it is published, and nothing before that.
 * The author may reshape the Draft without restriction; only an additive Draft
 * can become the next version. A reshaping that removes or redefines what a
 * published version carries is a new contract, publishable only under a new
 * name (spec §7.7).
 *
 * §6.2 measures the rule "against every prior published version", and
 * `checkAdditivityAgainstAll` is that, literally. A single-prior check against
 * the highest would suffice when every prior publication was itself gated —
 * additivity is transitive — but the literal form also holds when it wasn't
 * (a grandfathered import, a migrated database), and the corpus is small.
 *
 * "Redefined" means the parts of a Property that participate in the contract:
 * NAME, supplying ROLE, MANDATORY, PROPAGATE, and DEFAULT (spec §6.2, 8 Sept
 * revision). Description and Sample are documentary — §6.4: "this
 * specification takes no view of them" — so changing them redefines nothing.
 *
 * CHANNELS ARE STRICTER STILL (§6.2): "a Profile's Channels are fixed by its
 * first published version" — a later version can neither add, remove, nor
 * redefine one. A Property a Node does not use can be ignored; an open
 * Channel nobody speaks on is indistinguishable from a broken one.
 *
 * Findings follow §15.1: structured and actionable, naming the gate, the
 * offending element, and the rule. An agent must be able to act on a refusal
 * without parsing prose, so the human-readable message is an extra field and
 * never the payload. Deliberately NO successor name is proposed on rejection:
 * "this specification defines no relationship between Profiles, and none SHALL
 * be inferred from their names" (§13.4, spec §7.7).
 */

import type { ProfileVersion, Property } from './model.ts';

export type AdditivityFinding =
  | {
      code: 'additivity.property_removed';
      gate: 'additivity';
      property: string;
      prior_version: number;
      message: string;
    }
  | {
      code: 'additivity.property_redefined';
      gate: 'additivity';
      property: string;
      prior_version: number;
      /** Which contract-bearing attribute moved, with both values. */
      attribute: 'role' | 'mandatory' | 'propagate' | 'default';
      was: string | boolean;
      now: string | boolean;
      message: string;
    }
  | {
      code: 'additivity.added_property_not_optional';
      gate: 'additivity';
      property: string;
      message: string;
    }
  | {
      code: 'additivity.duplicate_property_name';
      gate: 'additivity';
      property: string;
      message: string;
    }
  | {
      code: 'additivity.channel_added' | 'additivity.channel_removed' | 'additivity.channel_redefined';
      gate: 'additivity';
      channel: string;
      prior_version: number;
      message: string;
    };

export type AdditivityResult = {
  additive: boolean;
  findings: AdditivityFinding[];
  /** Documentary-only changes, reported for information and blocking nothing. */
  documentaryChanges: { property: string; attribute: 'description' | 'sample' }[];
};

/**
 * May this candidate be published as the next version after `prior`?
 *
 * Pass `prior = null` for a first publication: with no prior version there is
 * nothing to be additive over, and only the internal uniqueness rule applies.
 */
export function checkAdditivity(
  candidate: ProfileVersion,
  prior: ProfileVersion | null,
  priorVersionNumber = 0,
): AdditivityResult {
  const findings: AdditivityFinding[] = [];
  const documentaryChanges: AdditivityResult['documentaryChanges'] = [];

  // Uniqueness across both roles (spec §6.3) — checked here as well as in the
  // conformance report, because a duplicate makes the by-name comparison below
  // ill-defined and must therefore block publication in its own right.
  const seen = new Map<string, Property>();
  for (const property of candidate.properties) {
    if (seen.has(property.name)) {
      findings.push({
        code: 'additivity.duplicate_property_name',
        gate: 'additivity',
        property: property.name,
        message: `Property "${property.name}" appears more than once; names are unique across both roles (spec §6.3).`,
      });
    }
    seen.set(property.name, property);
  }

  if (prior) {
    const candidateByName = new Map(candidate.properties.map((p) => [p.name, p]));

    for (const before of prior.properties) {
      const after = candidateByName.get(before.name);

      if (!after) {
        findings.push({
          code: 'additivity.property_removed',
          gate: 'additivity',
          property: before.name,
          prior_version: priorVersionNumber,
          message: `Property "${before.name}" exists in version ${priorVersionNumber} and is absent from the candidate. A version SHALL NOT remove any Property of a prior version (spec §6.2). A contract without it takes a new name (spec §7.7).`,
        });
        continue;
      }

      // The contract-bearing attributes, each reported separately so an agent
      // fixes exactly what moved.
      const redefinitions: [AdditivityFinding & { code: 'additivity.property_redefined' }][] = [];
      const check = (
        attribute: 'role' | 'mandatory' | 'propagate' | 'default',
        was: string | boolean | undefined,
        now: string | boolean | undefined,
      ) => {
        if (was !== now) {
          findings.push({
            code: 'additivity.property_redefined',
            gate: 'additivity',
            property: before.name,
            prior_version: priorVersionNumber,
            attribute,
            was: was ?? '(absent)',
            now: now ?? '(absent)',
            message: `Property "${before.name}" has ${attribute}=${String(was)} in version ${priorVersionNumber} and ${String(now)} in the candidate. A version SHALL NOT redefine any Property (spec §6.2); the flag is fixed by publication (spec §6.3).`,
          });
        }
      };
      void redefinitions;

      check('role', before.role, after.role);
      check('mandatory', before.mandatory, after.mandatory);
      check('propagate', before.propagate, after.propagate);
      // Default is contract, not documentary (§6.2, §6.4): where defined it is
      // the value a Connection starts with at Bind, and absent is a different
      // contract from any present value.
      check('default', before.default, after.default);

      // Documentary drift is legal and worth surfacing — §6.3 takes no view of
      // Description and Sample, so these block nothing.
      if (before.description !== after.description) {
        documentaryChanges.push({ property: before.name, attribute: 'description' });
      }
      if ((before.sample ?? null) !== (after.sample ?? null)) {
        documentaryChanges.push({ property: before.name, attribute: 'sample' });
      }
    }

    // Channels are fixed by the FIRST published version (§6.2): no additions,
    // no removals, no redefinition of any attribute — including the
    // documentary ones, since "what a Channel's protocol requires" is exactly
    // what its Description and role mappings state.
    const candidateChannels = new Map((candidate.channels ?? []).map((c) => [c.name, c]));
    for (const before of prior.channels ?? []) {
      const after = candidateChannels.get(before.name);
      if (!after) {
        findings.push({
          code: 'additivity.channel_removed',
          gate: 'additivity',
          channel: before.name,
          prior_version: priorVersionNumber,
          message: `Channel "${before.name}" exists in version ${priorVersionNumber} and is absent from the candidate. A Profile's Channels are fixed by its first published version (spec §6.2); a different set of Channels is a new contract and takes a new name (spec §7.7).`,
        });
        continue;
      }
      const moved =
        before.mode !== after.mode ||
        before.protocol !== after.protocol ||
        (before.providerRole ?? null) !== (after.providerRole ?? null) ||
        (before.consumerRole ?? null) !== (after.consumerRole ?? null);
      if (moved) {
        findings.push({
          code: 'additivity.channel_redefined',
          gate: 'additivity',
          channel: before.name,
          prior_version: priorVersionNumber,
          message: `Channel "${before.name}" differs from version ${priorVersionNumber} in mode, protocol, or role mapping. A version SHALL NOT redefine a Channel (spec §6.2).`,
        });
      }
    }
    const priorChannelNames = new Set((prior.channels ?? []).map((c) => c.name));
    for (const channel of candidate.channels ?? []) {
      if (!priorChannelNames.has(channel.name)) {
        findings.push({
          code: 'additivity.channel_added',
          gate: 'additivity',
          channel: channel.name,
          prior_version: priorVersionNumber,
          message: `Channel "${channel.name}" is new in the candidate. A version SHALL NOT add a Channel: an open Channel nobody speaks on is indistinguishable from a broken one (spec §6.2).`,
        });
      }
    }

    // Everything the candidate adds must be optional (spec §6.2). This is what
    // makes any two versions compatible in what they require, and a Capability
    // declared at a lower version satisfy every requirement of a higher one.
    const priorNames = new Set(prior.properties.map((p) => p.name));
    for (const property of candidate.properties) {
      if (!priorNames.has(property.name) && property.mandatory) {
        findings.push({
          code: 'additivity.added_property_not_optional',
          gate: 'additivity',
          property: property.name,
          message: `Property "${property.name}" is new in the candidate and is Mandatory. Every Property a version adds SHALL be optional (spec §6.2); a new requirement is a new contract and takes a new name (spec §7.7).`,
        });
      }
    }
  }

  return { additive: findings.length === 0, findings, documentaryChanges };
}

/**
 * The literal form of spec §6.2: the candidate measured against EVERY prior
 * published version, deduplicating identical findings across priors so an
 * agent sees each problem once, attributed to the earliest version that
 * establishes it.
 */
export function checkAdditivityAgainstAll(
  candidate: ProfileVersion,
  priors: { version: number; content: ProfileVersion }[],
): AdditivityResult {
  if (priors.length === 0) return checkAdditivity(candidate, null, 0);

  const merged: AdditivityFinding[] = [];
  const seen = new Set<string>();
  let documentaryChanges: AdditivityResult['documentaryChanges'] = [];

  for (const prior of [...priors].sort((a, b) => a.version - b.version)) {
    const result = checkAdditivity(candidate, prior.content, prior.version);
    for (const finding of result.findings) {
      const key = `${finding.code}:${'property' in finding ? finding.property : finding.channel}${
        'attribute' in finding ? ':' + finding.attribute : ''
      }`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(finding);
      }
    }
    // Documentary drift reported against the highest prior only — the one an
    // author actually diffed their draft against.
    documentaryChanges = result.documentaryChanges;
  }

  return { additive: merged.length === 0, findings: merged, documentaryChanges };
}
