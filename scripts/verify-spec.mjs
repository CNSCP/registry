#!/usr/bin/env node
/**
 * Verify the normative anchor.
 *
 * REGISTRY-DESIGN.md is written against one identifiable copy of the CNS/CP
 * 2026 revision. Every `spec §n` citation in the design means that file and no
 * other. The revision was published on 16 September 2026, which changed who can
 * check the pin — anyone, now — but not the need for one: a published working
 * draft still revises.
 *
 * The hazard this guards against is silent drift: the working copy is revised,
 * the design's citations quietly stop matching, and nothing notices until
 * someone implements to a section that has moved. A hash turns "the 2026
 * revision" from a description into an identifier.
 *
 * Semantics are deliberate:
 *
 *   absent   → SKIP. The spec is not in this repository and is not expected to
 *              be; a contributor without a copy is not failing anything.
 *   present, matching   → PASS.
 *   present, different  → FAIL, loudly, naming both hashes. The revision moved,
 *              and the design must be re-read against it before anything built
 *              on those citations is trusted.
 *
 * Update the expected hash ONLY together with a re-read of the design against
 * the new revision. Bumping it to make this pass is the one thing that makes
 * the check worthless.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_ANCHOR } from './spec-anchor.mjs';

// The pin itself lives in one place, so the documents can be checked against
// the same constant this script checks the file against (test/spec-anchor.test.ts).
const EXPECTED = SPEC_ANCHOR;

const here = dirname(fileURLToPath(import.meta.url));
// The specification is now public, in its own repository, checked out as a
// sibling of this one. Still outside THIS repository's version control, so the
// hash remains the identifier rather than a commit of ours.
const specPath = resolve(here, '../..', EXPECTED.file);

if (!existsSync(specPath)) {
  console.log(`SKIP  ${EXPECTED.file} is not present.`);
  console.log(`      This repository does not carry the specification. It is public — clone it beside`);
  console.log(`      this repository, or fetch the pinned bytes directly:`);
  console.log(`        ${EXPECTED.published}`);
  console.log(`      Expected at: ${specPath}`);
  process.exit(0);
}

const bytes = readFileSync(specPath);
const actual = createHash('sha256').update(bytes).digest('hex');

if (actual === EXPECTED.sha256) {
  console.log(`OK    ${EXPECTED.file}`);
  console.log(`      sha256 ${actual}`);
  console.log(`      ${bytes.length.toLocaleString()} bytes · ${EXPECTED.assembled}`);
  console.log(`      ${EXPECTED.sections}`);
  console.log(`      published at ${EXPECTED.published}`);
  process.exit(0);
}

console.error(`FAIL  the normative anchor has changed.\n`);
console.error(`      expected  ${EXPECTED.sha256}  (${EXPECTED.bytes.toLocaleString()} bytes)`);
console.error(`      found     ${actual}  (${bytes.length.toLocaleString()} bytes)\n`);
console.error(`      REGISTRY-DESIGN.md cites this document by section throughout, and its`);
console.error(`      §22 conformance checklist is written against it. A revision may have`);
console.error(`      renumbered, reworded, or reversed something this design depends on.\n`);
console.error(`      Re-read the design against the new revision, then update EXPECTED in`);
console.error(`      this file. Do not update it to make this pass.`);
process.exit(1);
