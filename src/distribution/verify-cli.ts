/**
 * Verify a Registry's journal from the outside — design §20.1, spec §9.3.
 *
 *   npm run verify-journal -- https://cp.cnscp.io [--since N] [--resolve]
 *
 * Walks the journal from genesis (or --since), checks that every link
 * continues from the last, recomputes every public event's hash from the
 * preimage it carries, checks every hashed subject and every published
 * document. With --resolve it then fetches each published version from the
 * same host and checks that what it SERVES hashes to what the act RECORDED —
 * "independent parties can detect whether copies agree" (spec §9.3), done by
 * one such party.
 *
 * It holds no state and needs no credential. Anyone can run it against
 * anyone's instance, which is the point.
 */

import { contentHash } from '../profile/store.ts';
import { JOURNAL_FORMAT, subjectContentHash, verifyPage, type JournalPage, type PublicEntry } from './journal.ts';

const args = process.argv.slice(2);
const host = (args.find((a) => !a.startsWith('--')) ?? 'https://cp.cnscp.io').replace(/\/+$/, '');
const sinceArg = args.indexOf('--since');
let since = sinceArg === -1 ? 0 : Number(args[sinceArg + 1]);
const resolveToo = args.includes('--resolve');
if (!Number.isInteger(since) || since < 0) {
  console.error('--since takes a non-negative integer');
  process.exit(2);
}

let expected: { seq: number; event_hash: string | null } | undefined = since === 0 ? { seq: 0, event_hash: null } : undefined;
let entries = 0;
let publicActs = 0;
let documents = 0;
let failed = 0;
const publications: PublicEntry[] = [];

for (;;) {
  const response = await fetch(`${host}/distribution/journal?since=${since}&limit=1000`);
  if (response.status === 416) {
    // An instance holds the journal from its bootstrap onward (§20.1). Start
    // there; the links before it are the authoritative host's to answer for.
    const body = (await response.json()) as { earliest_seq: number; authoritative?: string };
    console.log(`this host holds the journal from seq ${body.earliest_seq}; verifying from there (earlier links: ${body.authoritative ?? 'the authoritative host'})`);
    since = body.earliest_seq;
    expected = undefined;
    continue;
  }
  if (!response.ok) {
    console.error(`${host}/distribution/journal answered ${response.status}`);
    process.exit(1);
  }
  const page = (await response.json()) as JournalPage;
  if (page.journal_format !== JOURNAL_FORMAT) {
    console.error(`journal_format ${page.journal_format}; this verifier speaks ${JOURNAL_FORMAT}`);
    process.exit(1);
  }
  if (page.entries.length === 0) break;

  const { failures, head } = verifyPage(page.entries, expected);
  for (const f of failures) {
    failed++;
    console.error(`seq ${f.seq}: ${f.reason} — ${f.detail}`);
  }
  for (const e of page.entries) {
    entries++;
    if (e.public) {
      publicActs++;
      if (e.document !== undefined) documents++;
      if (e.action === 'profile.publish') publications.push(e);
    }
  }
  expected = head ?? expected;
  since = page.next;
  if (!page.more) {
    if (page.head && head && (page.head.seq !== head.seq || page.head.event_hash !== head.event_hash)) {
      failed++;
      console.error(`the host reports head ${page.head.seq}/${page.head.event_hash}; the journal ended at ${head.seq}/${head.event_hash}`);
    }
    break;
  }
}

console.log(`${host}: ${entries} event(s), ${publicActs} public act(s), ${documents} document(s) checked; chain head seq ${expected?.seq ?? since}`);

if (resolveToo) {
  let agreed = 0;
  for (const e of publications) {
    const ref = e.ref;
    const recorded = subjectContentHash(e) ?? e.content_hash;
    if (!ref || ref.version === undefined || !recorded) continue;
    const response = await fetch(`${host}/${ref.name}:${ref.version}`, { headers: { accept: 'application/cp+json; profile=2026' } });
    if (!response.ok) {
      failed++;
      console.error(`${ref.name}:${ref.version}: the host answered ${response.status} for a version its journal says it published`);
      continue;
    }
    const served = contentHash(await response.json());
    if (served !== recorded) {
      failed++;
      console.error(`${ref.name}:${ref.version}: served content hashes to ${served}; the act recorded ${recorded}`);
    } else {
      agreed++;
    }
  }
  console.log(`${agreed} of ${publications.length} published version(s) served as recorded`);
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('intact');
