/**
 * `npm run anchor` — the operator's weekly act (design §20.2).
 *
 *   npm run anchor -- --dry-run
 *   npm run anchor
 *   npm run anchor -- --new-key cp-anchor-2027-01     (rotation)
 *
 * This runs on the OPERATOR'S OWN MACHINE and nowhere else. It reads a private
 * key from disk, fetches the current chain head from the Registry over HTTP
 * like any other client, signs, and prints the anchor document. Publishing it
 * is a separate step by design (`--emit <file>`, then the operator's own
 * `kubectl exec … operator -- anchor publish` and a commit to the mirror), so
 * that nothing here needs credentials for the cluster and nothing in the
 * cluster ever needs the key.
 *
 * The one rule this file exists to enforce: **the private key never leaves
 * this machine, and never enters a chat, an email, a screenshot or a log.**
 * Nothing here prints it, and the signature it produces reveals nothing of it.
 *
 * Cadence (§20.2): after anything irreversible — a publication, a deprecation,
 * an allocation, a transfer — and weekly regardless. Everything up to the
 * signed head is attested; everything after it is not.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign, createPublicKey } from 'node:crypto';
import { canonicalAnchor, canonicalKey, signAnchor, type AnchorDocument, type AnchorFields } from '../distribution/anchor.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'origin': { type: 'string' },
    'key': { type: 'string' },
    'key-id': { type: 'string' },
    'emit': { type: 'string' },
    'dry-run': { type: 'boolean' },
    'new-key': { type: 'string' },
  },
});

const ORIGIN = (values.origin ?? process.env['CP_ANCHOR_ORIGIN'] ?? 'https://cp.cnscp.io').replace(/\/$/, '');
const KEY_PATH = resolve(values.key ?? process.env['CP_ANCHOR_KEY'] ?? `${homedir()}/.cp-registry/anchor-key.pem`);
const KEY_ID = values['key-id'] ?? process.env['CP_ANCHOR_KEY_ID'] ?? '';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Rotation, and first-time setup: make a key, print what must be published. */
function newKey(keyId: string): void {
  const path = KEY_PATH;
  if (existsSync(path)) {
    fail(
      `${path} already exists. Refusing to overwrite a signing key: if you mean to rotate, move the old one aside first ` +
        `(keep it — it is what vouches for the new one), then run this again.`,
    );
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, { mode: 0o600 });
  chmodSync(path, 0o600);

  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  const publicRaw = raw.toString('base64url');
  const fingerprint = raw.toString('hex').replace(/(.{4})/g, '$1 ').trim();

  console.log(`\nPrivate key written to ${path} (mode 0600). It never leaves this machine.\n`);
  console.log(`  key_id      ${keyId}`);
  console.log(`  public_key  ${publicRaw}`);
  console.log(`\nFingerprint, for publishing where a person can check it by eye:\n\n  ${fingerprint}\n`);
  console.log(
    `Publish that fingerprint in REGISTRY-DESIGN.md §20.2, the README and on cnscp.io — the first key is the one\n` +
      `thing this mechanism cannot vouch for, and saying so plainly is the honest position.\n`,
  );
  console.log(`Then register the public key on the Registry:\n`);
  console.log(
    `  kubectl -n cp-registry exec deploy/registry -- npm run operator -- anchor trust \\\n` +
      `      --key-id ${keyId} --public-key ${publicRaw} --by <operator email>\n`,
  );
}

/** Vouch for a successor key with the current one (§20.2 rotation). */
function vouch(keyId: string, publicRaw: string, validFrom: string): void {
  const privateKey = createPrivateKey(readFileSync(KEY_PATH, 'utf8'));
  const body = { key_id: keyId, public_key: publicRaw, valid_from: validFrom, valid_to: null };
  const signature = cryptoSign(null, canonicalKey(body), privateKey).toString('base64url');
  console.log(JSON.stringify({ ...body, vouched_by: KEY_ID, vouch_signature: signature }, null, 2));
}

async function main(): Promise<void> {
  if (values['new-key']) return newKey(values['new-key']);
  if (!KEY_ID) fail('--key-id (or CP_ANCHOR_KEY_ID) is required: an anchor names the key that signed it.');
  if (!existsSync(KEY_PATH)) {
    fail(`No signing key at ${KEY_PATH}. Create one with:  npm run anchor -- --new-key <key id>`);
  }

  const response = await fetch(`${ORIGIN}/distribution/status`);
  if (!response.ok) fail(`${ORIGIN}/distribution/status answered ${response.status}`);
  const status = (await response.json()) as { role?: string; head?: { seq: number; event_hash: string | null } };
  if (status.role !== 'authoritative') fail(`${ORIGIN} reports role "${status.role}"; only the authoritative host is anchored.`);
  if (!status.head?.event_hash) fail(`${ORIGIN} has no chain head to anchor.`);

  const fields: AnchorFields = {
    journal_format: 1,
    origin: ORIGIN,
    head_seq: status.head.seq,
    head_event_hash: status.head.event_hash,
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    key_id: KEY_ID,
  };

  if (values['dry-run']) {
    console.log('Would sign:\n');
    console.log(canonicalAnchor(fields).toString('utf8'));
    console.log('\nNothing was signed and nothing was published.');
    return;
  }

  const privateKey = createPrivateKey(readFileSync(KEY_PATH, 'utf8'));
  // Confirm the key on disk is the one named, before producing a signature
  // nothing will accept.
  const raw = (createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  const document: AnchorDocument = { ...fields, signature: signAnchor(fields, privateKey) };
  const json = JSON.stringify(document, null, 2);

  if (values.emit) {
    writeFileSync(values.emit, `${json}\n`);
    console.log(`anchor written to ${values.emit}`);
  } else {
    console.log(json);
  }

  console.log(`\nhead ${fields.head_seq} · signed by ${KEY_ID} (${raw.toString('base64url').slice(0, 12)}…)\n`);
  console.log('Publish it, both places:\n');
  console.log(
    `  kubectl -n cp-registry exec -i deploy/registry -- npm run operator -- anchor publish --by <operator email> <<'JSON'\n${json}\nJSON\n`,
  );
  console.log(`  and commit the same document to the public anchor mirror.\n`);
}

try {
  await main();
} catch (error) {
  fail((error as Error).message);
}
