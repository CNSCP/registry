/**
 * The workspace beside an instance — design §20.3; spec §6.3, §7.1, §7.3.
 *
 * An organization's unpublished forms, held on the organization's own host
 * next to its mirror of canon. "Its content lives with its author, outside
 * the Registry, and reaches another party only as the author conveys it"
 * (spec §6.3): this table is where the author keeps it, and `GET
 * /<name>:unpublished` on this host is the conveyance.
 *
 * The wall between this and the mirror is the point of the design, and it is
 * enforced by what each side has nowhere to put: the workspace table has no
 * version numbers and no place in the feed; the mirror tables have no draft
 * columns (migration 6). Nothing in this file touches `profile` or
 * `profile_version` except to READ them — to ask whether a name qualifies,
 * and what the latest published version says.
 *
 * Two classes of name, and no third (§20.3):
 *   - a registered name whose Prefix is held by one of the workspace's
 *     organizations — checked against the mirrored allocation rows at every
 *     read and write, so a released or transferred name goes dark at once;
 *   - a `test.*` name, "for local exercise, never globally resolvable" (spec
 *     §7.1), which no organization holds and no mirror row vouches for —
 *     admitted only when the operator says so.
 */

import type { Queryable } from '../db.ts';
import { nameProblem, tlpOf } from '../names.ts';
import { contentHash } from '../profile/store.ts';

export type WorkspaceConfig = {
  /** Organization ids (stable across the §8.4 rename act) whose held names this workspace may hold. */
  orgs: string[];
  /** Admit `test.*` forms (spec §7.1). Off unless set: a public host should choose this on purpose. */
  test: boolean;
};

/** The fields the Registry stamps at publication (§13.4); never the author's to set on a draft. */
export const STAMPED_HEADER_FIELDS = ['Version', 'Status', 'Pub Date'] as const;

export type WorkspaceForm = {
  name: string;
  /** As stored: the author's document less the stamped fields. */
  document: Record<string, unknown>;
  content_hash: string;
  updated_at: Date;
  updated_by: string;
};

export type Qualification =
  | { ok: true; kind: 'held'; org: { id: string; name: string } }
  | { ok: true; kind: 'test' }
  | { ok: false; reason: 'malformed' | 'not-registered' | 'not-held' | 'test-not-admitted'; detail: string };

/**
 * May this workspace hold a form under this name? Answered from the mirror,
 * never from the form's own existence — a row whose name stopped qualifying
 * is dark, whatever the table says.
 */
export async function qualifies(db: Queryable, config: WorkspaceConfig, name: string): Promise<Qualification> {
  const problem = nameProblem(name);
  if (problem) return { ok: false, reason: 'malformed', detail: `not a well-formed Profile name (${problem})` };

  if (tlpOf(name) === 'test') {
    return config.test
      ? { ok: true, kind: 'test' }
      : {
          ok: false,
          reason: 'test-not-admitted',
          detail: 'This workspace does not admit test.* forms (spec §7.1); set WORKSPACE_TEST=true to admit them.',
        };
  }

  const { rows } = await db.query<{ org_id: string; holder: string }>(
    `SELECT a.org_id, o.name AS holder
       FROM profile p
       JOIN allocation a ON a.id = p.allocation_id
       JOIN organization o ON o.id = a.org_id
      WHERE p.name = $1 AND p.discarded_at IS NULL`,
    [name],
  );
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      reason: 'not-registered',
      detail: `"${name}" is not a registered name on this instance's mirror; a workspace holds forms for registered names only (spec §7.3), or under test.* (spec §7.1).`,
    };
  }
  if (!config.orgs.includes(row.org_id)) {
    return {
      ok: false,
      reason: 'not-held',
      detail: `"${name}" is held by ${row.holder}, which is not an organization this workspace serves; an unpublished form lives with its author (spec §6.3).`,
    };
  }
  return { ok: true, kind: 'held', org: { id: row.org_id, name: row.holder } };
}

export async function getForm(db: Queryable, name: string): Promise<WorkspaceForm | null> {
  const { rows } = await db.query<WorkspaceForm>(
    `SELECT name, document, content_hash, updated_at, updated_by FROM workspace_profile WHERE name = $1`,
    [name],
  );
  return rows[0] ?? null;
}

/** Which of these names this workspace holds a form for — one query, for pills and links. */
export async function heldForms(db: Queryable, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM workspace_profile WHERE name = ANY($1::text[])`, [names]);
  return new Set(rows.map((r) => r.name));
}

export type SaveRefusal =
  | { refused: 'not-a-document'; detail: string }
  | { refused: 'name-mismatch'; detail: string }
  | { refused: 'precondition-required'; detail: string }
  | { refused: 'precondition-failed'; detail: string; current: string }
  | { refused: 'nothing-to-match'; detail: string };

export type SaveResult = { created: boolean; form: WorkspaceForm };

/** The ETag of a form: its content hash, quoted. One value for every representation — the surface is `no-store`. */
export function formETag(form: Pick<WorkspaceForm, 'content_hash'>): string {
  return `"${form.content_hash}"`;
}

/** Does an If-Match header name this form? Handles the list form, `*`, and a weak prefix. */
export function ifMatchMatches(ifMatch: string, form: Pick<WorkspaceForm, 'content_hash'>): boolean {
  if (ifMatch.trim() === '*') return true;
  const etag = formETag(form);
  return ifMatch
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag || candidate === form.content_hash);
}

/**
 * The stamped fields, dropped. Version, Status and Pub Date are the
 * Registry's to assign at publication (§13.4); on a draft they would be an
 * author's claim about something only publication decides. Everything else
 * is kept exactly as sent, key order included.
 */
export function intake(document: Record<string, unknown>): Record<string, unknown> {
  const header = document['Header'];
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return document;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(header as Record<string, unknown>)) {
    if (!(STAMPED_HEADER_FIELDS as readonly string[]).includes(key)) kept[key] = value;
  }
  return { ...document, Header: kept };
}

/**
 * Save a form. The caller has already checked the credential and that the
 * name qualifies; this checks the document and the precondition, and writes.
 *
 * `If-Match` is REQUIRED over an existing form (428 without it): with
 * co-authors, a save that does not say which form it is replacing is a save
 * that can silently discard someone else's work. A first save needs nothing
 * — and an `If-Match` with no form to match is refused rather than ignored.
 */
export async function saveForm(
  db: Queryable,
  name: string,
  body: unknown,
  options: { ifMatch?: string | undefined; by: string },
): Promise<SaveResult | SaveRefusal> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { refused: 'not-a-document', detail: 'The unpublished form is a JSON document in the 2026 shape: an object with a Header (spec §6.6).' };
  }
  const raw = body as Record<string, unknown>;
  const header = raw['Header'];
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return { refused: 'not-a-document', detail: 'The document carries no Header object (spec §6.6).' };
  }
  const declared = (header as Record<string, unknown>)['Name'];
  if (declared !== name) {
    return {
      refused: 'name-mismatch',
      detail: `Header.Name is ${JSON.stringify(declared ?? null)}; a form saved at /${name}:unpublished must say "${name}", so the page never draws one Profile under another's citation.`,
    };
  }

  const existing = await getForm(db, name);
  if (existing) {
    if (options.ifMatch === undefined) {
      return {
        refused: 'precondition-required',
        detail: `A form for "${name}" exists (ETag ${formETag(existing)}); send If-Match with the ETag you read so a co-author's newer save is never overwritten unseen.`,
      };
    }
    if (!ifMatchMatches(options.ifMatch, existing)) {
      return {
        refused: 'precondition-failed',
        detail: `The form for "${name}" has moved on since you read it (now ${formETag(existing)}); fetch it, merge, and save again.`,
        current: existing.content_hash,
      };
    }
  } else if (options.ifMatch !== undefined && options.ifMatch.trim() !== '*') {
    return { refused: 'nothing-to-match', detail: `No form for "${name}" exists yet, so there is nothing for If-Match to match; omit it on a first save.` };
  }

  const document = intake(raw);
  const hash = contentHash(document);
  const { rows } = await db.query<WorkspaceForm>(
    `INSERT INTO workspace_profile (name, document, content_hash, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (name) DO UPDATE
       SET document = EXCLUDED.document, content_hash = EXCLUDED.content_hash,
           updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING name, document, content_hash, updated_at, updated_by`,
    [name, JSON.stringify(document), hash, options.by],
  );
  return { created: existing === null, form: rows[0]! };
}

export type RemoveResult = { removed: true } | { removed: false; refused: 'not-found' } | SaveRefusal;

export async function removeForm(db: Queryable, name: string, options: { ifMatch?: string | undefined }): Promise<RemoveResult> {
  const existing = await getForm(db, name);
  if (!existing) return { removed: false, refused: 'not-found' };
  if (options.ifMatch !== undefined && !ifMatchMatches(options.ifMatch, existing)) {
    return {
      refused: 'precondition-failed',
      detail: `The form for "${name}" has moved on since you read it (now ${formETag(existing)}).`,
      current: existing.content_hash,
    };
  }
  await db.query(`DELETE FROM workspace_profile WHERE name = $1`, [name]);
  return { removed: true };
}

/**
 * The form as answered: the stored document with `Status: Unpublished`
 * stamped into the Header — the mirror image of what canon stamps at
 * publication (§13.4) — and nothing else added. No Version, no Pub Date:
 * this is not a version, and the answer must never look like one.
 */
export function presentForm(form: WorkspaceForm): { document: Record<string, unknown>; text: string } {
  const stored = form.document;
  const header = (stored['Header'] ?? {}) as Record<string, unknown>;
  const { Name, ...rest } = header;
  const document = { ...stored, Header: { ...(Name === undefined ? {} : { Name }), Status: 'Unpublished', ...rest } };
  return { document, text: JSON.stringify(document) };
}

/**
 * Has the form moved on since the latest published version? Compared on the
 * CONTRACT fields — Properties, Channels, and the Header less the fields the
 * Registry stamps or stewardship may move — so a form re-saved unchanged
 * after publication reads "same as version n", and one edited since reads
 * "moved on". Null for a name with no published version (every `test.*`).
 */
export async function movedOnSince(
  db: Queryable,
  form: WorkspaceForm,
): Promise<{ version: number; same: boolean } | null> {
  const { rows } = await db.query<{ version: number; content: unknown }>(
    `SELECT v.version, v.content
       FROM profile_version v JOIN profile p ON p.id = v.profile_id
      WHERE p.name = $1 AND p.discarded_at IS NULL
      ORDER BY v.version DESC LIMIT 1`,
    [form.name],
  );
  const latest = rows[0];
  if (!latest) return null;
  return { version: latest.version, same: comparable(form.document) === comparable(latest.content) };
}

const COMPARED_OUT = new Set<string>([...STAMPED_HEADER_FIELDS, 'Owner', 'Website']);

function comparable(document: unknown): string {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return contentHash(document);
  const doc = document as Record<string, unknown>;
  const header = doc['Header'];
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return contentHash(document);
  const fixed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(header as Record<string, unknown>)) if (!COMPARED_OUT.has(k)) fixed[k] = v;
  return contentHash({ ...doc, Header: fixed });
}

export type FormListing = WorkspaceForm & { qualification: Qualification };

/** Every form this workspace holds, each with whether it still qualifies — for the `/workspace` index. */
export async function listForms(db: Queryable, config: WorkspaceConfig): Promise<FormListing[]> {
  const { rows } = await db.query<WorkspaceForm>(
    `SELECT name, document, content_hash, updated_at, updated_by FROM workspace_profile ORDER BY name`,
  );
  const out: FormListing[] = [];
  for (const form of rows) out.push({ ...form, qualification: await qualifies(db, config, form.name) });
  return out;
}

/**
 * Remove every form whose name no longer qualifies — released, transferred
 * away, or a `test.*` form after the operator stopped admitting them. Called
 * after each sync (§20.3): a draft under a name nobody holds belongs to
 * nobody. Returns the names swept.
 */
export async function sweep(db: Queryable, config: WorkspaceConfig): Promise<string[]> {
  const swept: string[] = [];
  for (const form of await listForms(db, config)) {
    if (form.qualification.ok) continue;
    await db.query(`DELETE FROM workspace_profile WHERE name = $1`, [form.name]);
    swept.push(form.name);
  }
  return swept;
}

/** The holders this workspace serves, by name, from the mirror — for the boot log and the index page. */
export async function holders(db: Queryable, config: WorkspaceConfig): Promise<{ id: string; name: string | null }[]> {
  if (config.orgs.length === 0) return [];
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM organization WHERE id = ANY($1::uuid[])`, [config.orgs]);
  const known = new Map(rows.map((r) => [r.id, r.name]));
  return config.orgs.map((id) => ({ id, name: known.get(id) ?? null }));
}
