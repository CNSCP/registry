/**
 * The normative anchor, in one place.
 *
 * This constant is the identifier of the specification copy that
 * REGISTRY-DESIGN.md is written against. `scripts/verify-spec.mjs` checks a
 * file against it; `test/spec-anchor.test.ts` checks the PROSE against it, so
 * the README and the design document cannot go on describing a pin the code
 * has moved past.
 *
 * That second check exists because it has now happened twice: a fact is
 * corrected in code and left standing in the sentence beside it. On 16
 * September the pin moved here and in the design document while the README
 * still named the 8 September working copy — the code right, the prose
 * describing the state before it, and nothing to notice.
 *
 * `abbreviate()` is exported for the same reason: the shortened form the
 * README prints is DERIVED from the hash rather than typed beside it.
 */

export const SPEC_ANCHOR = {
  /** Where the copy sits, relative to the directory holding this repository. */
  file: 'cnscp/specification/cnscp-2026-specification.md',
  sha256: '072d443584c28b383c228a002ad10cc7e2f5d9bcab40b80d182d385062be6c0e',
  bytes: 136899,
  assembled: 'published 16 September 2026',
  sections: '§1–§10 and Appendices A–C · editors Toby Considine and Anto Budiardjo',
  // Published 16 Sept 2026 (§25 Q10). The same bytes are served here, so the
  // pin can be checked by anyone, not only by someone holding the file:
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

/** The short form the README prints: first eight, ellipsis, last six. */
export function abbreviate(sha256 = SPEC_ANCHOR.sha256) {
  return `${sha256.slice(0, 8)}…${sha256.slice(-6)}`;
}
