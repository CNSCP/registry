/**
 * Verify a Registry's journal from the outside — design §20.1, spec §9.3.
 *
 *   npm run verify-journal -- https://cp.cnscp.io [--since N] [--resolve] [--anchor <root key id>]
 *
 * Walks the journal from genesis (or --since), checks that every link
 * continues from the last, recomputes every public event's hash from the
 * preimage it carries, checks every hashed subject and every published
 * document. With --resolve it then fetches each published version from the
 * same host and checks that the CONTRACT it serves — the document minus
 * Status, Owner and Website, which spec §6.6 lets move after publication —
 * is the contract the journal carries: "independent parties can detect
 * whether copies agree" (spec §9.3), done by one such party.
 *
 * With --anchor it also fetches the signed anchor (§20.2) and checks that the
 * head the operator committed to publicly is the head this walk arrived at.
 * That is the one check hashes cannot make for themselves: a fork is two
 * internally perfect chains, and only an outside signature distinguishes them.
 *
 * It holds no state and needs no credential. Anyone can run it against
 * anyone's instance, which is the point.
 */

import { contractHash } from '../profile/store.ts';
import { JOURNAL_FORMAT, verifyPage, type JournalPage, type PublicEntry } from './journal.ts';
import { keyIsTrusted, verifyAnchor, ageSeconds, type AnchorDocument, type AnchorKey } from './anchor.ts';

const args = process.argv.slice(2);
const host = (args.find((a) => !a.startsWith('--')) ?? 'https://cp.cnscp.io').replace(/\/+$/, '');
const sinceArg = args.indexOf('--since');
let since = sinceArg === -1 ? 0 : Number(args[sinceArg + 1]);
const resolveToo = args.includes('--resolve');
const anchorArg = args.indexOf('--anchor');
const anchorRoot = anchorArg === -1 ? null : args[anchorArg + 1];
if (anchorArg !== -1 && (!anchorRoot || anchorRoot.startsWith('--'))) {
  console.error('--anchor takes the key id you already trust, e.g. --anchor cp-anchor-2026-09');
  process.exit(2);
}
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
/** seq → event_hash, as verified by THIS walk; what an anchor is compared against. */
const seenHashes = new Map<number, string>();

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
    seenHashes.set(e.seq, e.event_hash);
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
  let skipped = 0;
  for (const e of publications) {
    const ref = e.ref;
    if (!ref || ref.version === undefined) continue;
    if (e.document === undefined) {
      skipped++; // an instance serves the journal from its bootstrap on; earlier documents are the upstream's to show
      continue;
    }
    const response = await fetch(`${host}/${ref.name}:${ref.version}`, { headers: { accept: 'application/cp+json; profile=2026' } });
    if (!response.ok) {
      failed++;
      console.error(`${ref.name}:${ref.version}: the host answered ${response.status} for a version its journal says it published`);
      continue;
    }
    const served = contractHash(await response.json());
    const recorded = contractHash(e.document);
    if (served !== recorded) {
      failed++;
      console.error(`${ref.name}:${ref.version}: the served contract hashes to ${served}; the published document's contract hashes to ${recorded}`);
    } else {
      agreed++;
    }
  }
  if (skipped > 0) console.log(`${skipped} publication(s) precede this host's journal copy and were not compared`);
  console.log(`${agreed} of ${publications.length - skipped} published version(s) serve the contract that was published`);
}

if (anchorRoot) {
  const anchorResponse = await fetch(`${host}/.well-known/cp-anchor`);
  if (!anchorResponse.ok) {
    failed++;
    console.error(`no anchor published at ${host}/.well-known/cp-anchor (${anchorResponse.status}); a fork would be undetectable`);
  } else {
    const document = (await anchorResponse.json()) as AnchorDocument;
    const keysResponse = await fetch(`${host}/.well-known/cp-keys`);
    const keys: AnchorKey[] = keysResponse.ok ? ((await keysResponse.json()) as { keys: AnchorKey[] }).keys : [];
    const chain = keyIsTrusted(keys, document.key_id, anchorRoot);

    if (!chain.trusted) {
      failed++;
      console.error(`the anchor is signed by "${document.key_id}", which is ${chain.reason} relative to the key you named`);
    } else if (!verifyAnchor(document, chain.key.public_key)) {
      failed++;
      console.error(`the anchor's signature does not verify under ${document.key_id}`);
    } else if (document.head_seq > (expected?.seq ?? since)) {
      console.log(`anchor at seq ${document.head_seq} is ahead of this walk (seq ${expected?.seq ?? since}); nothing compared`);
    } else {
      // Find what THIS walk recorded at the anchored sequence.
      const held = seenHashes.get(document.head_seq);
      if (!held) {
        console.log(`anchor at seq ${document.head_seq} precedes the journal this host serves; nothing compared`);
      } else if (held !== document.head_event_hash) {
        failed++;
        console.error(
          `FORK: the anchor signs head ${document.head_event_hash} at seq ${document.head_seq}; this journal says ${held}. ` +
            `The history served here is not the one the operator committed to publicly.`,
        );
      } else {
        const age = ageSeconds(document);
        console.log(
          `anchor verified at seq ${document.head_seq}, signed by ${document.key_id} ${Math.round(age / 3600)}h ago` +
            (age > 14 * 86400 ? ' — STALE: nothing since is attested' : ''),
        );
      }
    }
  }
}

if (failed > 0) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log('intact');
