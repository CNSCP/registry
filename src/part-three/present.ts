/**
 * The answer for a version — design §18, spec §6.2, §6.6, §9.3.
 *
 * A version's CONTENT — its Properties and Channels and the Header fields
 * fixed by publication — never changes, and the frozen bytes are replayed
 * verbatim so that one name and version is one content commitment. But the
 * specification excludes three Header fields from that commitment: Status
 * "changes only as §6.3 provides", and Owner and Website "may change after
 * publication" (spec §6.6) — these three "may differ between answers" (spec
 * §9.3). A Registry that accepts a stewardship change and then keeps
 * answering with the frozen value is not honouring the field the
 * specification made mutable; that is what this file corrects.
 *
 * So the answer is the frozen document with those three fields OVERLAID
 * from the row — and only when they differ, so the common case is still a
 * verbatim replay. Content hash, ETag and Content-Digest are those of the
 * frozen document: they commit to the content, and the content did not move.
 * A party checking a served copy against the journal compares CONTRACT
 * hashes (contractHash: the document minus the three fields) — see
 * verify-cli — which is exactly the comparison spec §9.3 asks for.
 *
 * An instance applies the same overlay from its own rows, so two hosts that
 * hold the same journal give the same bytes.
 */

import type { ResolvedVersion } from './store.ts';

const STATUS_WORD = { published: 'Published', deprecated: 'Deprecated' } as const;

/** The Header fields excluded from a version's content (spec §6.2, §6.6). */
export const MUTABLE_HEADER_FIELDS = ['Status', 'Owner', 'Website'] as const;

export type Presented = {
  /** The document as answered: frozen content, current lifecycle and stewardship fields. */
  document: Record<string, unknown>;
  /** The bytes to send: the stored bytes verbatim unless an overlay changed them. */
  text: string;
  overlaid: boolean;
};

export function presentVersion(v: ResolvedVersion): Presented {
  const stored = v.served_bytes ? v.served_bytes.toString('utf8') : JSON.stringify(v.content);
  const document = JSON.parse(stored) as Record<string, unknown>;
  const header = ((document['Header'] as Record<string, unknown> | undefined) ??= {});

  let overlaid = false;
  const current: [string, string | null][] = [
    ['Status', STATUS_WORD[v.status]],
    ['Owner', v.header_owner],
    ['Website', v.header_website],
  ];
  for (const [field, value] of current) {
    // A null stewardship value means the row never had one (a grandfathered
    // import with no Owner, say); the document is left exactly as published.
    if (value === null || value === undefined) continue;
    if (header[field] !== value) {
      header[field] = value;
      overlaid = true;
    }
  }

  // JSON.parse/stringify keeps key order, so an overlay changes only the
  // values of existing keys (a field the document never had appends to the
  // Header). Untouched documents are sent as stored.
  return { document, text: overlaid ? JSON.stringify(document) : stored, overlaid };
}
