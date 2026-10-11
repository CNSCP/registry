/**
 * Import — design §20.3, "Sharing a form".
 *
 * What arrives (a carrier, a bare document, or what a link answered) is
 * checked item by item and either previewed or applied. Each item stands or
 * falls on its own. The rules, in the order they are asked:
 *
 *   - the item is a document, under a well-formed name, whose Header.Name is
 *     that name, and whose hash is the one it claims;
 *   - a `test` name lands only where `test.*` is admitted, and never over the
 *     host's own `test` name;
 *   - a real name this host's organizations hold lands as an ordinary save —
 *     own work, editable; any other registered name lands as a SHARED COPY,
 *     read-only here; an unregistered name lands nowhere;
 *   - a form already held that differs is replaced only when the caller sends
 *     back the ETag it was shown (`replace`), so nothing is overwritten by
 *     someone who has not seen what they are overwriting;
 *   - a host never overwrites its own work with someone else's.
 */

import type { Queryable } from '../db.ts';
import { nameProblem, tlpOf } from '../names.ts';
import { hashOf, kindOf, type IncomingSet } from './carrier.ts';
import { formETag, getForm, qualifies, saveForm, testRegistration, writeSharedCopy, type WorkspaceConfig } from './store.ts';

export type ImportRefusal =
  | 'malformed'
  | 'not-a-document'
  | 'name-mismatch'
  | 'hash-mismatch'
  | 'duplicate'
  | 'test-not-admitted'
  | 'not-registered'
  | 'conflicts-own'
  | 'conflicts-shared';

export type ImportRow = {
  name: string;
  kind: 'unpublished' | 'test';
  /** How it lands: as the host's own work, or as a shared copy. Absent when refused before that was known. */
  as?: 'own' | 'shared';
  /** The holder the MIRROR records — never the one the file claims. Null under test. */
  holder?: string | null;
  outcome: 'new' | 'identical' | 'differs' | 'refused';
  refusal?: ImportRefusal;
  detail?: string;
  /** The incoming form's hash. */
  etag?: string;
  /** For `differs`: the ETag of what is held, to send back in `replace`. */
  current?: string;
  /** True when this call wrote it. */
  applied: boolean;
};

export type ImportOptions = {
  apply: boolean;
  /** name → the ETag of the held form the caller agrees to replace. */
  replace: Record<string, string>;
  /** The credential's signature, for updated_by. */
  by: string;
  catchUp?: () => Promise<void>;
};

const refuse = (name: string, refusal: ImportRefusal, detail: string, extra: Partial<ImportRow> = {}): ImportRow => ({
  name,
  kind: kindOf(name || 'x.x'),
  outcome: 'refused',
  refusal,
  detail,
  applied: false,
  ...extra,
});

export async function importSet(db: Queryable, config: WorkspaceConfig, set: IncomingSet, options: ImportOptions): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  const source = set.origin ?? 'a file of unknown origin';
  let caughtUp = false;

  for (const item of set.items) {
    const { name } = item;
    const problem = nameProblem(name);
    if (problem) {
      rows.push(refuse(name, 'malformed', `"${name}" is not a well-formed Profile name (${problem}).`));
      continue;
    }
    if (seen.has(name)) {
      rows.push(refuse(name, 'duplicate', `"${name}" appears more than once in what was imported; a host holds one form per name.`));
      continue;
    }
    seen.add(name);
    if (!item.document) {
      rows.push(refuse(name, 'not-a-document', 'The item carries no document.'));
      continue;
    }
    const header = item.document['Header'];
    const declared = header !== null && typeof header === 'object' && !Array.isArray(header) ? (header as Record<string, unknown>)['Name'] : undefined;
    if (declared !== name) {
      rows.push(refuse(name, 'name-mismatch', `Header.Name is ${JSON.stringify(declared ?? null)}, not "${name}", so the page would draw one Profile under another's citation.`));
      continue;
    }
    const hash = hashOf(item.document);
    if (item.claimed !== null && item.claimed !== hash) {
      rows.push(refuse(name, 'hash-mismatch', `The document does not hash to the ETag it came with (${item.claimed}); it was changed or damaged on the way, so it is not what was shared.`, { etag: hash }));
      continue;
    }

    // How would it land?
    let as: 'own' | 'shared';
    let holder: string | null = null;
    if (tlpOf(name) === 'test') {
      if (!config.test) {
        rows.push(refuse(name, 'test-not-admitted', 'This workspace does not admit test.* names (spec §7.1).'));
        continue;
      }
      const registered = await testRegistration(db, name);
      const held = await getForm(db, name);
      if (registered && (!held || held.kind === 'own')) {
        rows.push(refuse(name, 'conflicts-own', `"${name}" is this host's own test name; a host never overwrites its own work with someone else's. Release it here first if the shared one should take its place.`, { as: 'shared', holder: null, etag: hash }));
        continue;
      }
      as = 'shared';
    } else {
      let own = await qualifies(db, config, name, 'own');
      if (!own.ok && own.reason === 'not-registered' && options.catchUp && !caughtUp) {
        caughtUp = true;
        await options.catchUp();
        own = await qualifies(db, config, name, 'own');
      }
      if (own.ok && own.kind === 'held') {
        as = 'own';
        holder = own.org.name;
      } else if (!own.ok && own.reason === 'not-held') {
        const shared = await qualifies(db, config, name, 'shared');
        if (!shared.ok || shared.kind !== 'shared') {
          rows.push(refuse(name, 'not-registered', shared.ok ? 'unexpected qualification' : shared.detail));
          continue;
        }
        as = 'shared';
        holder = shared.holder?.name ?? null;
      } else {
        rows.push(refuse(name, own.ok ? 'not-registered' : own.reason === 'malformed' ? 'malformed' : 'not-registered', own.ok ? 'unexpected qualification' : own.detail));
        continue;
      }
    }

    const existing = await getForm(db, name);
    if (as === 'own' && existing?.kind === 'shared') {
      rows.push(refuse(name, 'conflicts-shared', `This host holds a shared copy under "${name}"${existing.origin ? ` from ${existing.origin}` : ''}; remove it before saving the organization's own form here.`, { as, holder, etag: hash }));
      continue;
    }
    if (as === 'shared' && existing?.kind === 'own') {
      rows.push(refuse(name, 'conflicts-own', `"${name}" holds this host's own form; a host never overwrites its own work with someone else's.`, { as, holder, etag: hash }));
      continue;
    }

    const base = { name, kind: kindOf(name), as, holder, etag: hash } as const;
    if (existing && existing.content_hash === hash) {
      rows.push({ ...base, outcome: 'identical', applied: false });
      continue;
    }
    const outcome = existing ? 'differs' : 'new';
    const current = existing ? formETag(existing) : undefined;
    const agreed = existing ? options.replace[name] !== undefined && bare(options.replace[name]!) === existing.content_hash : true;

    if (!options.apply || !agreed) {
      rows.push({
        ...base,
        outcome,
        applied: false,
        ...(current ? { current } : {}),
        ...(options.apply && !agreed
          ? { detail: `What is held here (${current}) differs; send it back in "replace" to replace it with what was imported.` }
          : {}),
      });
      continue;
    }

    if (as === 'own') {
      const saved = await saveForm(db, name, item.document, {
        ifMatch: existing ? formETag(existing) : undefined,
        by: `${options.by} · imported from ${source}`,
      });
      if ('refused' in saved) {
        rows.push({ ...base, outcome: 'refused', refusal: 'conflicts-own', detail: saved.detail, applied: false });
        continue;
      }
    } else {
      const written = await writeSharedCopy(db, name, item.document, {
        origin: set.origin,
        verified: set.verified,
        via: set.via,
        link: set.link,
        by: options.by,
      });
      if (!written) {
        rows.push({ ...base, outcome: 'refused', refusal: 'conflicts-own', detail: 'This host saved its own form under that name meanwhile; nothing was written.', applied: false });
        continue;
      }
    }
    rows.push({ ...base, outcome, applied: true, ...(current ? { current } : {}) });
  }
  return rows;
}

function bare(etag: string): string {
  return etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}
