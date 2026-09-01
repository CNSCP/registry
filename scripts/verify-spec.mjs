#!/usr/bin/env node
/**
 * Verify the normative anchor.
 *
 * REGISTRY-DESIGN.md is written against one identifiable copy of the CNS/CP
 * 2026 revision, which is still in draft and not yet public. Every `spec §n`
 * citation in the design means that file and no other.
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

const EXPECTED = {
  file: 'cnscp_2026_spec_clean_read_s1-10.md',
  sha256: 'bbeec3f74a87230c3f1144370cce3f9ec24e989c9a5931fbb4923efcc22be09b',
  bytes: 88501,
  assembled: '26 August 2026',
  sections: '§1 v0.5, §2 v0.3, §3 v0.6, §4 v0.4, §5 v0.7, §6 v0.5, §7 v0.5, §8 v0.6, §9 v0.6, §10 v0.3',
};

const here = dirname(fileURLToPath(import.meta.url));
// The spec sits beside the design document, one level above this repository.
const specPath = resolve(here, '../..', EXPECTED.file);

if (!existsSync(specPath)) {
  console.log(`SKIP  ${EXPECTED.file} is not present.`);
  console.log(`      The 2026 revision is in draft and not public; this repository does not carry it.`);
  console.log(`      Expected beside REGISTRY-DESIGN.md, at: ${specPath}`);
  process.exit(0);
}

const bytes = readFileSync(specPath);
const actual = createHash('sha256').update(bytes).digest('hex');

if (actual === EXPECTED.sha256) {
  console.log(`OK    ${EXPECTED.file}`);
  console.log(`      sha256 ${actual}`);
  console.log(`      ${bytes.length.toLocaleString()} bytes · assembled ${EXPECTED.assembled}`);
  console.log(`      ${EXPECTED.sections}`);
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
