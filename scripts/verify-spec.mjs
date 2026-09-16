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

const EXPECTED = {
  file: 'cnscp/specification/cnscp-2026-specification.md',
  sha256: '072d443584c28b383c228a002ad10cc7e2f5d9bcab40b80d182d385062be6c0e',
  bytes: 136899,
  assembled: 'published 16 September 2026',
  sections: '§1–§10 and Appendices A–C · editors Toby Considine and Anto Budiardjo',
  // Published 16 Sept 2026 (§25 Q10). The same bytes are served here, so the
  // pin can now be checked by anyone, not only by someone holding the file:
  published: 'https://raw.githubusercontent.com/CNSCP/specification/main/cnscp-2026-specification.md',
};
// Prior anchors, for the record:
//   442043a7…8a712c8  8 Sept 2026, 134,887 bytes — the working copy this design
//                     was written against, one directory above the repository as
//                     cnscp_2026_spec_clean_read_s1-10.md. The 16 Sept publication
//                     changed no normative text: the same 108 normative sentences,
//                     every §1–§10 subsection heading identical; what was added is
//                     front matter (provenance, requirements language, terminology,
//                     clause status, reading order) and Appendix C, open issues.
//   bbeec3f7…22be09b  26 Aug 2026, 88,501 bytes — archived alongside it. The re-read
//                     that moved that pin: Unpublished rename, Registry-holds-no-
//                     unpublished-content, Channels, Default; design v0.6 has the deltas.

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
