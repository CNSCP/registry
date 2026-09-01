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
 * The comparison runs against the HIGHEST published version. That suffices
 * because additivity is transitive: every published version was additive over
 * its predecessor, so a Draft additive over version N is additive over all of
 * 1..N. (The spec draws the same consequence — "any two versions of one
 * Profile are compatible in what they require".)
 *
 * "Redefined" means the parts of a Property that participate in the contract:
 * NAME, supplying ROLE, MANDATORY, and PROPAGATE (design §13.4). Description
 * and Sample are documentary — §6.3: "this specification takes no view of
 * them" — so changing them redefines nothing.
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
      attribute: 'role' | 'mandatory' | 'propagate';
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
        attribute: 'role' | 'mandatory' | 'propagate',
        was: string | boolean,
        now: string | boolean,
      ) => {
        if (was !== now) {
          findings.push({
            code: 'additivity.property_redefined',
            gate: 'additivity',
            property: before.name,
            prior_version: priorVersionNumber,
            attribute,
            was,
            now,
            message: `Property "${before.name}" has ${attribute}=${String(was)} in version ${priorVersionNumber} and ${String(now)} in the candidate. A version SHALL NOT redefine any Property (spec §6.2); the flag is fixed by publication (spec §6.3).`,
          });
        }
      };
      void redefinitions;

      check('role', before.role, after.role);
      check('mandatory', before.mandatory, after.mandatory);
      check('propagate', before.propagate, after.propagate);

      // Documentary drift is legal and worth surfacing — §6.3 takes no view of
      // Description and Sample, so these block nothing.
      if (before.description !== after.description) {
        documentaryChanges.push({ property: before.name, attribute: 'description' });
      }
      if ((before.sample ?? null) !== (after.sample ?? null)) {
        documentaryChanges.push({ property: before.name, attribute: 'sample' });
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
