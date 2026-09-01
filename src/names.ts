/**
 * Reference and name grammar — design §3.1, spec §7.1 and §7.2.
 *
 *   reference    = "cp:" name [ ":" version-part ]
 *                / "cp:" tlp
 *   name         = tlp 1*("." sub-segment)          ; two segments minimum
 *   tlp          = segment
 *   version-part = 1*DIGIT / "draft"
 *   segment      = 1*( %x61-7A / %x30-39 / "-" )
 *
 * Two rules from the specification are load-bearing here and easy to lose:
 *
 *   1. Names are compared by EXACT STRING COMPARISON (spec §7.2). Nothing in
 *      this module normalises, case-folds, trims, or canonicalises an input on
 *      its way to storage. A name that differs by a byte is a different name.
 *      Uppercase `CP:` forms are documentary workstream identifiers, never
 *      resolvable Profiles, and are rejected rather than lowercased.
 *
 *   2. NO relationship may be inferred from a name's shape (spec §7.1, §7.7).
 *      `acme.meter.flow` is registrable whether or not `acme.meter` exists;
 *      `acme.chiller2` is not a successor to `acme.chiller`. This module
 *      therefore offers no parent(), no children(), and no tree walk. The only
 *      structural operation is `scopeCovers`, and it is a string-prefix test
 *      by design (design §8.3).
 */

/** Operational limits. Not from the specification — operator policy, published
 *  under §9.2 so a refusal is never a surprise (design §3.1). */
export const LIMITS = {
  maxNameBytes: 128,
  maxSegments: 8,
  maxSegmentBytes: 63,
} as const;

export type NameProblem =
  | 'empty'
  | 'not-lowercase'
  | 'bad-character'
  | 'empty-segment'
  | 'leading-hyphen'
  | 'trailing-hyphen'
  | 'segment-too-long'
  | 'name-too-long'
  | 'too-many-segments'
  | 'single-segment'
  | 'not-single-segment';

export class NameError extends Error {
  readonly problem: NameProblem;
  readonly input: string;

  constructor(problem: NameProblem, input: string, message: string) {
    super(message);
    this.name = 'NameError';
    this.problem = problem;
    this.input = input;
  }
}

const SEGMENT = /^[a-z0-9-]+$/;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Validate one segment. Returns the problem, or null if it is well-formed. */
function segmentProblem(segment: string): NameProblem | null {
  if (segment.length === 0) return 'empty-segment';
  if (!SEGMENT.test(segment)) {
    // Distinguish the common mistake (uppercase) from the general one, so the
    // refusal message can say something useful.
    return /[A-Z]/.test(segment) ? 'not-lowercase' : 'bad-character';
  }
  if (segment.startsWith('-')) return 'leading-hyphen';
  if (segment.endsWith('-')) return 'trailing-hyphen';
  if (byteLength(segment) > LIMITS.maxSegmentBytes) return 'segment-too-long';
  return null;
}

const MESSAGES: Record<NameProblem, string> = {
  'empty': 'is empty',
  'not-lowercase': 'contains uppercase; names are lowercase and compared exactly (spec §7.2)',
  'bad-character': 'contains a character outside a-z, 0-9 and hyphen',
  'empty-segment': 'has an empty segment',
  'leading-hyphen': 'has a segment beginning with a hyphen',
  'trailing-hyphen': 'has a segment ending with a hyphen',
  'segment-too-long': `has a segment longer than ${LIMITS.maxSegmentBytes} bytes`,
  'name-too-long': `is longer than ${LIMITS.maxNameBytes} bytes`,
  'too-many-segments': `has more than ${LIMITS.maxSegments} segments`,
  'single-segment': 'has one segment; a Profile name has at least two (spec §7.2)',
  'not-single-segment': 'has more than one segment; a Top Level Prefix is exactly one',
};

function fail(problem: NameProblem, input: string): never {
  throw new NameError(problem, input, `"${input}" ${MESSAGES[problem]}`);
}

/** Check a Top Level Prefix: exactly one well-formed segment. */
export function tlpProblem(input: string): NameProblem | null {
  if (input.length === 0) return 'empty';
  if (input.includes('.')) return 'not-single-segment';
  return segmentProblem(input);
}

export function isTlp(input: string): boolean {
  return tlpProblem(input) === null;
}

export function assertTlp(input: string): string {
  const problem = tlpProblem(input);
  if (problem) fail(problem, input);
  return input;
}

/**
 * Check a Profile name: two or more well-formed segments, within the
 * operational limits. Returns the problem, or null.
 */
export function nameProblem(input: string): NameProblem | null {
  if (input.length === 0) return 'empty';
  if (byteLength(input) > LIMITS.maxNameBytes) return 'name-too-long';

  const segments = input.split('.');
  if (segments.length < 2) {
    // A single segment is not a malformed Profile name — it is a well-formed
    // *allocation* reference. Spec §7.2: the Registry SHALL NOT register it as
    // a Profile. This is the check that keeps the bare `proto` record from
    // cp.padi.io out of the import (design §10.2 ruling 2).
    return 'single-segment';
  }
  if (segments.length > LIMITS.maxSegments) return 'too-many-segments';

  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) return problem;
  }
  return null;
}

export function isName(input: string): boolean {
  return nameProblem(input) === null;
}

export function assertName(input: string): string {
  const problem = nameProblem(input);
  if (problem) fail(problem, input);
  return input;
}

/** The Top Level Prefix of a name. Assumes a validated name. */
export function tlpOf(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

export function segmentsOf(name: string): string[] {
  return name.split('.');
}

/**
 * Does an authorization scope cover a name?
 *
 * String prefix, not a tree (design §6.4, §8.3). Scope `ashrae.135` covers
 * `ashrae.135` itself and any name beginning `ashrae.135.`. Nothing requires
 * `ashrae.135` to be registered, and no interior name need exist.
 *
 * The segment boundary matters: `ashrae.135` must NOT cover `ashrae.1350`.
 */
export function scopeCovers(scope: string, name: string): boolean {
  return name === scope || name.startsWith(scope + '.');
}

// --- References -------------------------------------------------------------

export type Reference =
  | { kind: 'allocation'; tlp: string }
  | { kind: 'profile'; name: string; tlp: string; version: number | 'draft' | null };

export class ReferenceError_ extends Error {
  readonly input: string;

  constructor(input: string, message: string) {
    super(message);
    this.name = 'ReferenceError';
    this.input = input;
  }
}

/**
 * Parse a citable reference (spec §7.2).
 *
 *   cp:acme               → the allocation held by Acme. Never a Profile.
 *   cp:acme.meter.flow    → a Profile name, version left to selection (spec §8.6)
 *   cp:acme.meter.flow:2  → published version 2
 *   cp:acme.meter.flow:draft → the Draft
 *
 * Integers and the reserved token `draft` can never collide, so the forms are
 * unambiguous. `CP:` is documentary and rejected.
 */
export function parseReference(input: string): Reference {
  if (input.startsWith('CP:')) {
    throw new ReferenceError_(
      input,
      'uppercase "CP:" is a documentary workstream identifier, never a resolvable reference (spec §7.2)',
    );
  }
  if (!input.startsWith('cp:')) {
    throw new ReferenceError_(input, 'is not a reference; it must begin with the "cp:" marker (spec §7.2)');
  }

  const body = input.slice(3);
  if (body.length === 0) throw new ReferenceError_(input, 'has no name after the "cp:" marker');

  // The version separator is the LAST colon; names never contain one.
  const colon = body.lastIndexOf(':');
  const namePart = colon === -1 ? body : body.slice(0, colon);
  const versionPart = colon === -1 ? null : body.slice(colon + 1);

  if (!namePart.includes('.')) {
    if (versionPart !== null) {
      throw new ReferenceError_(
        input,
        'gives a version for a one-segment reference; a Top Level Prefix denotes an allocation, which has no versions (spec §7.2)',
      );
    }
    const problem = tlpProblem(namePart);
    if (problem) fail(problem, namePart);
    return { kind: 'allocation', tlp: namePart };
  }

  const problem = nameProblem(namePart);
  if (problem) fail(problem, namePart);

  let version: number | 'draft' | null = null;
  if (versionPart !== null) {
    if (versionPart === 'draft') {
      version = 'draft';
    } else if (/^[0-9]+$/.test(versionPart)) {
      const n = Number(versionPart);
      if (n < 1) {
        throw new ReferenceError_(input, 'gives version 0; versions are integers assigned from 1 (spec §6.2)');
      }
      version = n;
    } else {
      throw new ReferenceError_(
        input,
        `has version part "${versionPart}"; a version is an integer or the reserved token "draft" (spec §7.2)`,
      );
    }
  }

  return { kind: 'profile', name: namePart, tlp: tlpOf(namePart), version };
}

/** Render a reference back to its citable form. */
export function formatReference(ref: Reference): string {
  if (ref.kind === 'allocation') return `cp:${ref.tlp}`;
  return ref.version === null ? `cp:${ref.name}` : `cp:${ref.name}:${ref.version}`;
}
