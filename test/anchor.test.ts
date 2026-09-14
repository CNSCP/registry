/**
 * The signed anchor — design §20.2, 14 September 2026.
 *
 * The claim under test is narrow and load-bearing: an instance holding a
 * DIFFERENT history from the one the operator signed finds out, and stops.
 * Everything else here exists to make sure that check cannot be fooled or
 * quietly skipped — a wrong key, an unvouched successor, a tampered field, an
 * anchor from another origin, an anchor for a sequence this instance has not
 * reached.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, createPublicKey, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import {
  canonicalAnchor,
  canonicalKey,
  checkAnchor,
  keyIsTrusted,
  signAnchor,
  verifyAnchor,
  ageSeconds,
  type AnchorDocument,
  type AnchorFields,
  type AnchorKey,
} from '../src/distribution/anchor.ts';
import { addKey, keyList, latestAnchor, recordAnchor, receiveAnchor } from '../src/distribution/anchor-store.ts';

const ORIGIN = 'https://cp.cnscp.io';

function pair(): { priv: KeyObject; raw: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url');
  return { priv: privateKey, raw };
}

const root = pair();
const successor = pair();
const stranger = pair();

const ROOT_ID = 'cp-anchor-2026-09';
const NEXT_ID = 'cp-anchor-2027-01';

function fields(over: Partial<AnchorFields> = {}): AnchorFields {
  return {
    journal_format: 1,
    origin: ORIGIN,
    head_seq: 5,
    head_event_hash: 'aaaa',
    at: new Date().toISOString(),
    key_id: ROOT_ID,
    ...over,
  };
}

function anchor(priv: KeyObject, over: Partial<AnchorFields> = {}): AnchorDocument {
  const f = fields(over);
  return { ...f, signature: signAnchor(f, priv) };
}

function vouchFor(keyId: string, publicRaw: string, by: KeyObject, vouchedBy: string): AnchorKey {
  const body = { key_id: keyId, public_key: publicRaw, valid_from: '2026-01-01T00:00:00.000Z', valid_to: null };
  return {
    ...body,
    vouched_by: vouchedBy,
    vouch_signature: cryptoSign(null, canonicalKey(body), by).toString('base64url'),
  };
}

const ROOT_KEY: AnchorKey = {
  key_id: ROOT_ID, public_key: root.raw,
  valid_from: '2026-01-01T00:00:00.000Z', valid_to: null, vouched_by: null, vouch_signature: null,
};

describe('the signed document (§20.2)', () => {
  test('canonical bytes are fixed, and do not depend on key order', () => {
    // One fixture, read twice: calling fields() twice takes two clock
    // readings, and a test that fails when the millisecond ticks is a test
    // nobody will trust.
    const base = fields();
    const a = canonicalAnchor(base);
    const reordered = { key_id: base.key_id, at: base.at, head_event_hash: base.head_event_hash, head_seq: base.head_seq, origin: base.origin, journal_format: base.journal_format };
    assert.equal(canonicalAnchor(reordered as AnchorFields).toString(), a.toString());
    assert.match(a.toString(), /^\{"journal_format":1,"origin":/);
  });

  test('a signature verifies, and any changed field breaks it', () => {
    const document = anchor(root.priv);
    assert.equal(verifyAnchor(document, root.raw), true);

    for (const tamper of [
      { head_event_hash: 'bbbb' },
      { head_seq: 6 },
      { origin: 'https://cp.example.test' },
      { at: new Date(Date.now() - 86_400_000).toISOString() },
    ]) {
      assert.equal(verifyAnchor({ ...document, ...tamper } as AnchorDocument, root.raw), false, JSON.stringify(tamper));
    }
  });

  test('a signature by another key does not verify', () => {
    assert.equal(verifyAnchor(anchor(stranger.priv), root.raw), false);
  });

  test('a malformed public key is refused rather than throwing', () => {
    assert.equal(verifyAnchor(anchor(root.priv), 'not-a-key'), false);
  });
});

describe('rotation (§20.2)', () => {
  const vouched = vouchFor(NEXT_ID, successor.raw, root.priv, ROOT_ID);

  test('the root is trusted as itself', () => {
    assert.equal(keyIsTrusted([ROOT_KEY], ROOT_ID, ROOT_ID).trusted, true);
  });

  test('a successor vouched for by the root is trusted', () => {
    const result = keyIsTrusted([ROOT_KEY, vouched], NEXT_ID, ROOT_ID);
    assert.equal(result.trusted, true);
  });

  test('an unvouched successor is not, however plausible it looks', () => {
    const unvouched: AnchorKey = { ...vouched, vouched_by: null, vouch_signature: null };
    assert.deepEqual(keyIsTrusted([ROOT_KEY, unvouched], NEXT_ID, ROOT_ID), { trusted: false, reason: 'unvouched' });
  });

  test('a successor vouched for by the WRONG key is refused', () => {
    const forged = vouchFor(NEXT_ID, successor.raw, stranger.priv, ROOT_ID);
    assert.deepEqual(keyIsTrusted([ROOT_KEY, forged], NEXT_ID, ROOT_ID), { trusted: false, reason: 'bad-vouch' });
  });

  test('a key that vouches for itself in a cycle terminates, and is not trusted', () => {
    const a = vouchFor('a', successor.raw, successor.priv, 'b');
    const b = vouchFor('b', successor.raw, successor.priv, 'a');
    assert.equal(keyIsTrusted([a, b], 'a', ROOT_ID).trusted, false);
  });

  test('an expired key is refused', () => {
    const expired: AnchorKey = { ...ROOT_KEY, valid_to: '2026-06-01T00:00:00.000Z' };
    assert.deepEqual(keyIsTrusted([expired], ROOT_ID, ROOT_ID, new Date('2026-09-14')), { trusted: false, reason: 'expired' });
  });

  test('an unknown key id is refused', () => {
    assert.deepEqual(keyIsTrusted([ROOT_KEY], 'nobody', ROOT_ID), { trusted: false, reason: 'unknown' });
  });
});

// --- Against a real database, and a real journal ------------------------------

let authoritative: Harness;
let instance: Harness;
let app: FastifyInstance;

before(async () => {
  authoritative = await freshDatabase();
  instance = await freshDatabase();

  const client = await authoritative.pool.connect();
  try {
    await client.query('BEGIN');
    await applySeed(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  await addKey(authoritative.pool, ROOT_KEY);
  await addKey(instance.pool, ROOT_KEY);

  app = Fastify();
  await registerResolutionRoutes(app, { db: authoritative.pool, html: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await authoritative.close();
  await instance.close();
});

describe('publishing an anchor (§20.2)', () => {
  test('/.well-known/cp-anchor says so plainly when none has been published', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/cp-anchor' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().anchor, null);
  });

  test('/.well-known/cp-keys serves the key list', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/cp-keys' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().keys[0].key_id, ROOT_ID);
    assert.equal(response.json().keys[0].vouched_by, null);
  });

  test('a recorded anchor is served, with its age', async () => {
    const { rows } = await authoritative.pool.query<{ seq: string; event_hash: string }>(
      `SELECT seq::text, event_hash FROM audit_event ORDER BY seq DESC LIMIT 1`,
    );
    const head = rows[0]!;
    const document = anchor(root.priv, { head_seq: Number(head.seq), head_event_hash: head.event_hash });
    assert.deepEqual(await recordAnchor(authoritative.pool, document), { recorded: true, already: false });

    const response = await app.inject({ method: 'GET', url: '/.well-known/cp-anchor' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.head_seq, Number(head.seq));
    assert.equal(body.key_id, ROOT_ID);
    assert.ok(typeof body.age_seconds === 'number');
    assert.equal(verifyAnchor(body as AnchorDocument, root.raw), true);
  });

  test('status carries the anchor instead of null', async () => {
    const response = await app.inject({ method: 'GET', url: '/distribution/status' });
    assert.equal(response.json().anchor.key_id, ROOT_ID);
  });

  test('recording the same anchor twice is a no-op', async () => {
    const current = await latestAnchor(authoritative.pool);
    const { verdict, ...document } = current!;
    assert.deepEqual(await recordAnchor(authoritative.pool, document as AnchorDocument), { recorded: true, already: true });
  });

  test('a SECOND, different head signed for the same sequence is refused and named as evidence', async () => {
    const current = await latestAnchor(authoritative.pool);
    const contradiction = anchor(root.priv, { head_seq: current!.head_seq, head_event_hash: 'a different head entirely' });
    const outcome = await recordAnchor(authoritative.pool, contradiction);
    assert.equal(outcome.recorded, false);
    assert.equal(outcome.recorded === false && outcome.code, 'contradiction');
    assert.match(outcome.recorded === false ? outcome.message : '', /fork made visible/);
  });
});

describe('an instance checking what it holds (§20.2)', () => {
  const HELD = 'e'.repeat(64);

  before(async () => {
    // Stand in for a followed journal: the entries this instance verified.
    await instance.pool.query(
      `INSERT INTO instance_state (upstream, journal_format, cursor_seq, head_hash, last_sync_at)
       VALUES ($1, 1, 10, $2, now())`,
      [ORIGIN, HELD],
    );
    for (const [seq, hash] of [[9, 'd'.repeat(64)], [10, HELD]] as const) {
      await instance.pool.query(
        `INSERT INTO journal_entry (seq, event_hash, prev_event_hash, entry) VALUES ($1, $2, NULL, '{}'::jsonb)`,
        [seq, hash],
      );
    }
  });

  test('a matching anchor verifies', async () => {
    const verdict = await checkAnchor(
      instance.pool,
      anchor(root.priv, { head_seq: 10, head_event_hash: HELD }),
      await keyList(instance.pool),
      { rootKeyId: ROOT_ID, expectOrigin: ORIGIN },
    );
    assert.deepEqual(verdict, { state: 'ok', head_seq: 10 });
  });

  test('a DIVERGENT anchor is caught, and names the sequence — the whole point', async () => {
    const verdict = await checkAnchor(
      instance.pool,
      anchor(root.priv, { head_seq: 10, head_event_hash: 'f'.repeat(64) }),
      await keyList(instance.pool),
      { rootKeyId: ROOT_ID, expectOrigin: ORIGIN },
    );
    assert.equal(verdict.state, 'diverged');
    assert.equal(verdict.state === 'diverged' && verdict.head_seq, 10);
    assert.equal(verdict.state === 'diverged' && verdict.held, HELD);
  });

  test('an anchor ahead of the cursor is kept, not treated as a failure', async () => {
    const verdict = await checkAnchor(
      instance.pool,
      anchor(root.priv, { head_seq: 99, head_event_hash: 'whatever' }),
      await keyList(instance.pool),
      { rootKeyId: ROOT_ID },
    );
    assert.equal(verdict.state, 'ahead');
  });

  test('an anchor for a sequence before this instance bootstrapped compares nothing', async () => {
    const verdict = await checkAnchor(
      instance.pool,
      anchor(root.priv, { head_seq: 3, head_event_hash: 'older' }),
      await keyList(instance.pool),
      { rootKeyId: ROOT_ID },
    );
    assert.equal(verdict.state, 'before-bootstrap');
  });

  test('an anchor for another origin is not evidence about this one', async () => {
    const verdict = await checkAnchor(
      instance.pool,
      anchor(root.priv, { head_seq: 10, head_event_hash: HELD, origin: 'https://cp.elsewhere.test' }),
      await keyList(instance.pool),
      { rootKeyId: ROOT_ID, expectOrigin: ORIGIN },
    );
    assert.deepEqual(verdict, { state: 'unverifiable', reason: 'wrong-origin' });
  });

  test('an anchor signed by a key the instance does not trust is unverifiable', async () => {
    const verdict = await checkAnchor(
      instance.pool,
      { ...fields({ head_seq: 10, head_event_hash: HELD, key_id: 'cp-anchor-forged' }), signature: 'x' },
      await keyList(instance.pool),
      { rootKeyId: ROOT_ID },
    );
    assert.deepEqual(verdict, { state: 'unverifiable', reason: 'unknown' });
  });

  test('receiving an anchor records it with its verdict', async () => {
    await receiveAnchor(instance.pool, anchor(root.priv, { head_seq: 10, head_event_hash: HELD }), {
      rootKeyId: ROOT_ID,
      expectOrigin: ORIGIN,
    });
    const { rows } = await instance.pool.query<{ verdict: string }>(
      `SELECT verdict FROM anchor ORDER BY recorded_at DESC LIMIT 1`,
    );
    assert.equal(rows[0]!.verdict, 'ok');
  });
});

describe('freshness (§20.2)', () => {
  test('age is reported from the signed timestamp, so a stale anchor cannot hide', () => {
    const old = { at: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    assert.ok(ageSeconds(old) > 29 * 86_400);
    assert.equal(ageSeconds({ at: new Date().toISOString() }) < 5, true);
  });
});

describe('what is served is what was signed (§20.2)', () => {
  // The bug this exists to prevent, found on the first real anchor: the
  // signer emitted `at` without milliseconds, the timestamptz column gave
  // them back, and the signature that verified in memory failed against the
  // document the Registry served. Both halves were tested; the round trip
  // between them was not.
  test('an anchor whose `at` has no milliseconds verifies AS SERVED', async () => {
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    assert.ok(!at.includes('.'), 'the fixture must carry the shape that broke');

    // Deterministic ordering: /.well-known/cp-anchor serves the newest, and
    // the anchors above were signed in the same second.
    await authoritative.pool.query(`DELETE FROM anchor`);

    const { rows } = await authoritative.pool.query<{ seq: string; event_hash: string }>(
      `SELECT seq::text, event_hash FROM audit_event ORDER BY seq DESC LIMIT 1`,
    );
    const head = rows[0]!;
    const document = anchor(root.priv, { head_seq: Number(head.seq) - 1, head_event_hash: head.event_hash, at });
    assert.equal(verifyAnchor(document, root.raw), true, 'sanity: it verifies before storage');

    await recordAnchor(authoritative.pool, document);

    const response = await app.inject({ method: 'GET', url: '/.well-known/cp-anchor' });
    const served = response.json() as AnchorDocument & { age_seconds: number };
    assert.equal(served.at, at, 'the served `at` is the signed `at`, byte for byte');

    const { age_seconds: _age, ...asServed } = served;
    assert.equal(verifyAnchor(asServed as AnchorDocument, root.raw), true, 'the served document verifies');
  });

  test('every column the signature covers survives the round trip unchanged', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/cp-anchor' });
    const served = response.json();
    const { rows } = await authoritative.pool.query<{ at_text: string; head_event_hash: string; signature: string }>(
      `SELECT at_text, head_event_hash, signature FROM anchor ORDER BY signed_at DESC, head_seq DESC LIMIT 1`,
    );
    assert.equal(served.at, rows[0]!.at_text);
    assert.equal(served.head_event_hash, rows[0]!.head_event_hash);
    assert.equal(served.signature, rows[0]!.signature);
  });
});

describe('a stored anchor that does not verify is not an anchor (§20.2)', () => {
  test('a verifiable anchor replaces an unverifiable one for the same head', async () => {
    await authoritative.pool.query(`DELETE FROM anchor`);

    // Exactly the state canon was left in: the row says one thing, the bytes
    // it was signed over said another, and nothing could supersede it.
    const at = '2026-09-14T16:07:30Z';
    const good = anchor(root.priv, { head_seq: 42, head_event_hash: 'c'.repeat(64), at });
    await recordAnchor(authoritative.pool, good);
    await authoritative.pool.query(`UPDATE anchor SET at_text = '2026-09-14T16:07:30.000Z' WHERE head_seq = 42`);

    const stored = await latestAnchor(authoritative.pool);
    const { verdict: _v, ...asStored } = stored!;
    assert.equal(verifyAnchor(asStored as AnchorDocument, root.raw), false, 'the fixture must be genuinely broken');

    // Re-publishing the same head with a document that DOES verify replaces it.
    const outcome = await recordAnchor(authoritative.pool, good, undefined, {
      verifyStored: (s) => verifyAnchor(s, root.raw),
    });
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.recorded === true && outcome.superseded, true);

    const after = await latestAnchor(authoritative.pool);
    const { verdict: _v2, ...asServed } = after!;
    assert.equal(after!.at, at, 'the replaced row carries the signed `at`, not a database rendering of it');
    assert.equal(verifyAnchor(asServed as AnchorDocument, root.raw), true);
  });

  test('a verifiable stored anchor is left alone — no needless rewriting', async () => {
    const outcome = await recordAnchor(
      authoritative.pool,
      { ...(await latestAnchor(authoritative.pool))! } as AnchorDocument,
      undefined,
      { verifyStored: (s) => verifyAnchor(s, root.raw) },
    );
    assert.deepEqual(outcome, { recorded: true, already: true });
  });

  test('a DIFFERENT head for the same sequence is still a contradiction, not a supersede', async () => {
    const other = anchor(root.priv, { head_seq: 42, head_event_hash: 'd'.repeat(64) });
    const outcome = await recordAnchor(authoritative.pool, other, undefined, {
      verifyStored: (s) => verifyAnchor(s, root.raw),
    });
    assert.equal(outcome.recorded, false);
    assert.equal(outcome.recorded === false && outcome.code, 'contradiction');
  });
});
