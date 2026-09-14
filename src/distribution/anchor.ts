/**
 * The signed anchor — design §4.3, §20.2, built 14 September 2026.
 *
 * The audit chain proves that nobody edited the history a party holds. It
 * cannot prove that the history a party holds is the one everybody else was
 * given: an authoritative host can keep two internally perfect chains and
 * serve one to each reader, and hashes alone will never say so. The anchor is
 * the outside reference that closes that gap — a public commitment to one
 * fact, signed by a key the Registry does not have:
 *
 *     at this moment, the head of my chain was exactly this.
 *
 * Everything here is deliberately small. Ed25519 over a canonical
 * serialization of six fields; no JWS, no certificate chain, no library.
 * The security of the whole mechanism rests on WHERE the private key lives
 * (§20.2): a key the Registry can use to sign is a key that can sign a forked
 * head, and an anchor signed by the thing that could fork proves nothing it
 * was built to prove. So nothing in this file reads a private key. Signing
 * happens in `src/anchor/sign-cli.ts`, which runs on the operator's own
 * machine; the Registry holds public keys and verifies.
 */

import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { Queryable } from '../db.ts';

export type AnchorFields = {
  journal_format: number;
  origin: string;
  head_seq: number;
  head_event_hash: string;
  /** RFC 3339, UTC. Freshness is checkable precisely because this is signed with the rest. */
  at: string;
  key_id: string;
};

export type AnchorDocument = AnchorFields & { signature: string };

export type AnchorKey = {
  key_id: string;
  /** base64url of the raw 32-byte Ed25519 public key. */
  public_key: string;
  valid_from: string;
  valid_to: string | null;
  /** The key_id that vouches for this one; null for the root, which is checked by eye. */
  vouched_by: string | null;
  /** That predecessor's signature over this key's canonical form. */
  vouch_signature: string | null;
};

/**
 * The bytes that are signed. Field order is fixed HERE and nowhere else, so a
 * signer and a verifier cannot disagree about what was signed — the classic
 * way a scheme like this rots is two implementations serializing differently
 * and a signature that verifies on one machine and not another.
 */
const ANCHOR_FIELDS = ['journal_format', 'origin', 'head_seq', 'head_event_hash', 'at', 'key_id'] as const;
const KEY_FIELDS = ['key_id', 'public_key', 'valid_from', 'valid_to'] as const;

function canonicalize(fields: Record<string, unknown>, order: readonly string[]): Buffer {
  const body = order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(fields[k] ?? null)}`).join(',');
  return Buffer.from(`{${body}}`, 'utf8');
}

export function canonicalAnchor(fields: AnchorFields): Buffer {
  return canonicalize(fields as unknown as Record<string, unknown>, ANCHOR_FIELDS);
}

export function canonicalKey(key: Pick<AnchorKey, 'key_id' | 'public_key' | 'valid_from' | 'valid_to'>): Buffer {
  return canonicalize(key as unknown as Record<string, unknown>, KEY_FIELDS);
}

/** SPKI DER prefix for an Ed25519 public key; the raw 32 bytes follow. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFrom(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32) throw new Error(`an Ed25519 public key is 32 bytes; got ${bytes.length}`);
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

/** Sign with an already-loaded private key. Used only by the operator's CLI. */
export function signAnchor(fields: AnchorFields, privateKey: KeyObject): string {
  return cryptoSign(null, canonicalAnchor(fields), privateKey).toString('base64url');
}

export function verifyAnchor(document: AnchorDocument, publicKeyRaw: string): boolean {
  const { signature, ...fields } = document;
  try {
    return cryptoVerify(
      null,
      canonicalAnchor(fields as AnchorFields),
      publicKeyFrom(publicKeyRaw),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

// --- The key list (§20.2 rotation) -------------------------------------------

export type KeyChainResult =
  | { trusted: true; key: AnchorKey }
  | { trusted: false; reason: 'unknown' | 'unvouched' | 'bad-vouch' | 'expired' | 'not-yet-valid' };

/**
 * Is this key_id trusted, given a key list and a root the verifier already
 * believes in? A key is trusted if it IS the root, or if it is vouched for —
 * signed — by a key that is itself trusted. Walking rather than recursing so
 * a cyclic list terminates rather than blowing the stack; a cycle simply
 * never reaches the root and comes back unvouched.
 */
export function keyIsTrusted(keys: readonly AnchorKey[], keyId: string, rootKeyId: string, now = new Date()): KeyChainResult {
  const byId = new Map(keys.map((k) => [k.key_id, k]));
  const seen = new Set<string>();

  let current = byId.get(keyId);
  if (!current) return { trusted: false, reason: 'unknown' };
  const subject = current;

  // Validity of the key actually in question. A rotated-out key that signed an
  // anchor while valid is a separate matter — the anchor carries its own `at`,
  // and the caller compares.
  if (new Date(subject.valid_from) > now) return { trusted: false, reason: 'not-yet-valid' };
  if (subject.valid_to && new Date(subject.valid_to) < now) return { trusted: false, reason: 'expired' };

  for (;;) {
    if (current.key_id === rootKeyId) return { trusted: true, key: subject };
    if (seen.has(current.key_id)) return { trusted: false, reason: 'unvouched' };
    seen.add(current.key_id);

    if (!current.vouched_by || !current.vouch_signature) return { trusted: false, reason: 'unvouched' };
    const voucher = byId.get(current.vouched_by);
    if (!voucher) return { trusted: false, reason: 'unvouched' };

    let ok = false;
    try {
      ok = cryptoVerify(
        null,
        canonicalKey(current),
        publicKeyFrom(voucher.public_key),
        Buffer.from(current.vouch_signature, 'base64url'),
      );
    } catch {
      ok = false;
    }
    if (!ok) return { trusted: false, reason: 'bad-vouch' };

    current = voucher;
  }
}

// --- Checking an anchor against what an instance actually verified ------------

export type AnchorVerdict =
  | { state: 'ok'; head_seq: number }
  /** The anchor is ahead of this instance's cursor; keep it and check on catching up. */
  | { state: 'ahead'; head_seq: number; cursor_seq: number }
  /** The anchored sequence predates this instance's bootstrap, so there is nothing local to compare. */
  | { state: 'before-bootstrap'; head_seq: number }
  | { state: 'diverged'; head_seq: number; signed: string; held: string }
  | { state: 'unverifiable'; reason: UnverifiableReason };

export type UnverifiableReason =
  | 'unknown'
  | 'unvouched'
  | 'bad-vouch'
  | 'expired'
  | 'not-yet-valid'
  | 'bad-signature'
  | 'wrong-origin';

/**
 * The whole point of the mechanism, in one function.
 *
 * The comparison is against `journal_entry` — the entries this instance
 * verified for itself as it synced. Re-fetching that stretch of journal from
 * upstream would be worthless: a host serving a fork would serve the fork that
 * matches its own anchor. The evidence has to be what the follower saw at the
 * time, not what the host is willing to say now.
 */
export async function checkAnchor(
  db: Queryable,
  document: AnchorDocument,
  keys: readonly AnchorKey[],
  options: { rootKeyId: string; expectOrigin?: string; now?: Date },
): Promise<AnchorVerdict> {
  if (options.expectOrigin && document.origin !== options.expectOrigin) {
    return { state: 'unverifiable', reason: 'wrong-origin' };
  }

  const chain = keyIsTrusted(keys, document.key_id, options.rootKeyId, options.now);
  if (!chain.trusted) return { state: 'unverifiable', reason: chain.reason };
  if (!verifyAnchor(document, chain.key.public_key)) {
    return { state: 'unverifiable', reason: 'bad-signature' };
  }

  const { rows: cursorRows } = await db.query<{ cursor_seq: string }>(`SELECT cursor_seq::text FROM instance_state`);
  const cursor = cursorRows[0] ? Number(cursorRows[0].cursor_seq) : 0;
  if (document.head_seq > cursor) {
    return { state: 'ahead', head_seq: document.head_seq, cursor_seq: cursor };
  }

  const { rows } = await db.query<{ event_hash: string }>(`SELECT event_hash FROM journal_entry WHERE seq = $1`, [
    document.head_seq,
  ]);
  const held = rows[0]?.event_hash;
  if (!held) return { state: 'before-bootstrap', head_seq: document.head_seq };

  if (held !== document.head_event_hash) {
    return { state: 'diverged', head_seq: document.head_seq, signed: document.head_event_hash, held };
  }
  return { state: 'ok', head_seq: document.head_seq };
}

/** Seconds since the anchor was signed. Staleness is reported, never fatal (§20.2). */
export function ageSeconds(document: Pick<AnchorDocument, 'at'>, now = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - new Date(document.at).getTime()) / 1000));
}
