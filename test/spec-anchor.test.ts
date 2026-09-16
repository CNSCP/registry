/**
 * The documents must describe the pin the code actually holds — 16 September 2026.
 *
 * Every other test here checks behaviour. This one checks prose, because the
 * failure it exists to catch is not a bug in the Registry: it is a true
 * sentence becoming false while nobody is looking at it. It has happened
 * twice in two days. The reserved-word list gained `account` and `auth` in
 * code while the allocations behind them did not follow; the specification
 * pin moved in `verify-spec.mjs` and in REGISTRY-DESIGN.md while the README
 * went on naming the copy it replaced. Both were found by a person reading,
 * which is not a mechanism.
 *
 * What this can assert is narrow and worth being honest about: that the
 * FACTS in these documents match the constant. It cannot tell you the
 * sentences around them are still true, or well written, or that the design
 * still describes what the code does. It closes one recurring hole, not the
 * category.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEC_ANCHOR, abbreviate } from '../scripts/spec-anchor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(resolve(here, '..', name), 'utf8');

const README = read('README.md');
const DESIGN = read('REGISTRY-DESIGN.md');

describe('the documents carry the pin the code holds (§25 Q10)', () => {
  test('the design document names the anchor in full', () => {
    // The normative anchor block gets the whole hash: this is the document
    // every `spec §n` citation belongs to, and an abbreviation there would be
    // an identifier a reader cannot check.
    assert.ok(
      DESIGN.includes(SPEC_ANCHOR.sha256),
      `REGISTRY-DESIGN.md does not contain the pinned hash ${SPEC_ANCHOR.sha256}. ` +
        `The pin moved in scripts/spec-anchor.mjs and the design document was left describing the previous one.`,
    );
  });

  test('the design document and the README agree on the byte count', () => {
    const written = SPEC_ANCHOR.bytes.toLocaleString('en-US'); // 136,899
    for (const [name, text] of [['REGISTRY-DESIGN.md', DESIGN], ['README.md', README]] as const) {
      assert.ok(
        text.includes(written) || text.includes(String(SPEC_ANCHOR.bytes)),
        `${name} does not state the pinned size (${written} bytes).`,
      );
    }
  });

  test('the README abbreviation is the pinned hash, shortened', () => {
    // Derived, never typed: `072d4435…be6c0e` cannot outlive a re-pin.
    assert.ok(
      README.includes(abbreviate()),
      `README.md does not contain ${abbreviate()}. If the README abbreviates the hash differently, ` +
        `change abbreviate() in scripts/spec-anchor.mjs — do not leave the two forms independent.`,
    );
  });

  test('neither document still names a superseded anchor as the current one', () => {
    // Prior pins may be cited as history — "the 8 September working copy
    // (442043a7…)" is a fact worth keeping. What must not appear is another
    // 64-hex string inside the design's own anchor block.
    const block = DESIGN.slice(DESIGN.indexOf('SHA-256'), DESIGN.indexOf('SHA-256') + 200);
    const hashes = block.match(/\b[0-9a-f]{64}\b/g) ?? [];
    assert.deepEqual(hashes, [SPEC_ANCHOR.sha256], 'the anchor block names exactly one hash, and it is the pin');
  });

  test('the README cites the design document at its current version', () => {
    // The other thing found stale on 16 September: the README said v0.11 while
    // the design was at v0.16.
    const status = DESIGN.match(/\*\*Status:\*\*\s*Draft\s*(v\d+\.\d+)/);
    assert.ok(status, 'REGISTRY-DESIGN.md has no "**Status:** Draft vN.N" line to read');
    const cited = README.match(/REGISTRY-DESIGN\.md\)\s*(v\d+\.\d+)/);
    assert.ok(cited, 'README.md does not cite a version for REGISTRY-DESIGN.md');
    assert.equal(
      cited[1],
      status[1],
      `README.md cites the design as ${cited[1]}; it is ${status[1]}.`,
    );
  });

  test('the published URL in the constant is the file the pin names', () => {
    // Not a network call — just that the two halves of the constant describe
    // the same document, so a re-pin cannot leave the URL pointing elsewhere.
    const leaf = SPEC_ANCHOR.file.split('/').at(-1)!;
    assert.ok(
      SPEC_ANCHOR.published.endsWith(leaf),
      `the published URL ends in a different file than the pin: ${SPEC_ANCHOR.published} vs ${leaf}`,
    );
  });
});
