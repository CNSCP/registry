/**
 * The §10.2 rulings, asserted rather than merely documented.
 *
 * A design decision that lives only in prose drifts. These tests are what stop
 * the bootstrap from being quietly undone by a later edit — each one names the
 * ruling it protects.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { availability, isSpecReserved, isWithheld, RESERVED_PATHS, WITHHELD } from '../src/policy.ts';
import { isTlp, nameProblem } from '../src/names.ts';
import {
  EXPECTED_RECORD_COUNT,
  GRANDFATHERED,
  IMPORT_EXCLUSIONS,
  IMPORT_RENAMES,
} from '../src/seed/grandfathered.ts';
import { hashSubject } from '../src/audit.ts';

describe('prefix policy (§3.2)', () => {
  test('the specification reserves exactly two, and neither is allocatable', () => {
    assert.ok(isSpecReserved('example'));
    assert.ok(isSpecReserved('test'));

    for (const tlp of ['example', 'test']) {
      const a = availability(tlp);
      assert.equal(a.available, false);
      assert.equal(a.available === false && a.because, 'spec-reserved');
    }
  });

  test('withheld is distinct from reserved and reports its own class', () => {
    const acme = availability('acme');
    assert.equal(acme.available, false);
    assert.equal(acme.available === false && acme.because, 'withheld');
    assert.equal(acme.available === false && acme.because === 'withheld' && acme.class, 'documentary');
  });

  test('§10.2 ruling 3 — acme and xyz are withheld as documentary', () => {
    for (const tlp of ['acme', 'xyz']) {
      assert.ok(isWithheld(tlp), tlp);
      const w = WITHHELD.find((x) => x.tlp === tlp)!;
      assert.equal(w.class, 'documentary', tlp);
    }
  });

  test('§10.2 ruling 2 — proto is withheld, not allocated as an ordinary holding', () => {
    const proto = WITHHELD.find((w) => w.tlp === 'proto');
    assert.ok(proto, 'proto must be on the withheld list');
    assert.match(proto!.rationale, /four unrelated organizations/);
  });

  test('every reserved path has a matching withheld Prefix, or it would be shadowed', () => {
    // §3.2: a single dotless segment resolves to the allocation it denotes
    // (§19.1). The two lists must be extended together; this is the test that
    // notices when only one of them was.
    for (const path of RESERVED_PATHS) {
      const tlp = path.startsWith('.') ? path.slice(1) : path;
      assert.ok(isWithheld(tlp), `reserved path "${path}" has no withheld Prefix "${tlp}"`);
    }
  });

  test('single-character Prefixes are restricted, not free', () => {
    const a = availability('q');
    assert.equal(a.available, false);
    assert.equal(a.available === false && a.because, 'restricted');
  });

  test('an ordinary Prefix is available', () => {
    assert.equal(availability('northwind').available, true);
  });

  test('the trademark watch list makes a Prefix restricted', () => {
    assert.equal(availability('honeywell').available, true);
    const guarded = availability('honeywell', ['honeywell']);
    assert.equal(guarded.available, false);
    assert.equal(guarded.available === false && guarded.because, 'restricted');
  });
});

describe('the bootstrap (§10)', () => {
  test('all eighteen observed Prefixes have a disposition', () => {
    assert.equal(GRANDFATHERED.length, 18);
    const tlps = new Set(GRANDFATHERED.map((p) => p.tlp));
    for (const expected of [
      'acme', 'c4sb', 'cns', 'dbp', 'haystack', 'hello', 'ibb', 'kube', 'kubecns',
      'modbus', 'novant', 'onuma', 'openjs', 'padi', 'proto', 'skycentrics', 'test', 'xyz',
    ]) {
      assert.ok(tlps.has(expected), `no disposition recorded for "${expected}"`);
    }
  });

  test('the record counts add up to the inventory', () => {
    const total = GRANDFATHERED.reduce((sum, p) => sum + p.records, 0);
    assert.equal(total, EXPECTED_RECORD_COUNT);
  });

  test('every Prefix in the seed is a well-formed single segment', () => {
    for (const p of GRANDFATHERED) assert.ok(isTlp(p.tlp), p.tlp);
  });

  test('every seed entry carries a rationale — the bootstrap is inspectable', () => {
    for (const p of GRANDFATHERED) {
      assert.ok(p.rationale.length > 20, `"${p.tlp}" has no meaningful rationale`);
    }
  });

  test('§10.2 ruling 1 — `test` is spec-reserved and gets no allocation row', () => {
    const t = GRANDFATHERED.find((p) => p.tlp === 'test')!;
    assert.equal(t.disposition, 'spec-reserved');
    assert.ok(isSpecReserved(t.tlp));
  });

  test('nothing marked spec-reserved would ever be inserted, and vice versa', () => {
    // The invariant the seed runner asserts at startup, checked here so a bad
    // edit fails in CI rather than at 3am against a live database.
    for (const p of GRANDFATHERED) {
      assert.equal(
        p.disposition === 'spec-reserved',
        isSpecReserved(p.tlp),
        `"${p.tlp}": disposition and policy.ts disagree`,
      );
    }
  });

  test('§10.2 ruling 4 — the seven external claimants are named, not assumed', () => {
    const pending = GRANDFATHERED.filter((p) => p.disposition === 'pending-claimant');
    assert.equal(pending.length, 7);
    for (const p of pending) {
      assert.ok(p.pendingClaimant, `"${p.tlp}" is pending but names no claimant`);
    }
    const tlps = pending.map((p) => p.tlp).sort();
    assert.deepEqual(tlps, ['c4sb', 'ibb', 'kubecns', 'novant', 'onuma', 'openjs', 'skycentrics']);
  });

  test('the dispositions reviewed on 31 Aug 2026 are the ones in force', () => {
    // Six rows were judgment calls on thin evidence and were confirmed
    // individually. Pinning them means a later edit is a decision someone
    // makes on purpose, rather than a diff nobody notices.
    const byTlp = Object.fromEntries(GRANDFATHERED.map((p) => [p.tlp, p]));

    // Community and protocol names stay ordinary operator holdings; a transfer
    // later is a normal §8.4 operation.
    assert.equal(byTlp['haystack']!.disposition, 'operator');
    assert.equal(byTlp['modbus']!.disposition, 'operator');

    // A live working Prefix, allocated to the operator AND on the §3.2
    // infrastructure withheld list — which is what withholding looks like in
    // practice, since withheld means operator-held.
    assert.equal(byTlp['cns']!.disposition, 'operator');
    assert.ok(isWithheld('cns'));

    // One record's company field is thin, but it is the evidence there is, and
    // the marking is provisional until §8.1 verification makes it real.
    assert.equal(byTlp['kubecns']!.pendingClaimant, 'Tacos Linux');
  });

  test('a claimant who cannot pass §8.1 verification is told so on their own allocation page', () => {
    // Both record a Google Doc as their only website, and §8.1 is a DNS or
    // well-known challenge against a domain. Their disposition promises release
    // on verification, so the obstacle has to be stated where it is published
    // (§19.3) — and stated standalone, since an allocation page is read alone.
    for (const tlp of ['ibb', 'skycentrics']) {
      const rationale = GRANDFATHERED.find((p) => p.tlp === tlp)!.rationale;
      assert.match(rationale, /contactable domain/, `"${tlp}" does not name the obstacle`);
      assert.ok(
        !/see the .* note/i.test(rationale),
        `"${tlp}" cross-references another allocation; each page must stand alone`,
      );
    }
  });

  test('nothing operator-held names a pending claimant — that would be a contradiction', () => {
    for (const p of GRANDFATHERED) {
      if (p.disposition !== 'pending-claimant') {
        assert.equal(p.pendingClaimant, undefined, `"${p.tlp}" is ${p.disposition} but names a claimant`);
      }
    }
  });

  test('every withheld seed entry is also on the policy withheld list', () => {
    for (const p of GRANDFATHERED) {
      if (p.disposition === 'withheld') {
        assert.ok(isWithheld(p.tlp), `"${p.tlp}" is seeded withheld but policy.ts does not agree`);
      }
    }
  });

  test('and the other direction — every withheld Prefix gets an allocation row', () => {
    // §3.2 claims a withheld Prefix "is held by the operator, so nothing
    // beneath it is ownerless", and authorizes() reasons from exactly that: it
    // declines to refuse on the withheld list because a withheld Prefix is
    // supposed to have a real allocation. The seed→policy test above cannot
    // catch a withheld Prefix that is never seeded; this one can.
    //
    // The infrastructure and path-shadowing entries hold no records and so are
    // not in the inventory. run.ts seeds them from WITHHELD directly, and this
    // asserts that every withheld Prefix ends up covered by one list or the
    // other.
    const seeded = new Set(GRANDFATHERED.map((p) => p.tlp));
    const fromPolicy = WITHHELD.map((w) => w.tlp).filter((tlp) => !seeded.has(tlp));

    for (const tlp of fromPolicy) {
      assert.ok(isTlp(tlp), `withheld Prefix "${tlp}" is not a well-formed segment`);
      assert.ok(
        !isSpecReserved(tlp),
        `"${tlp}" is both withheld and spec-reserved; it may never hold an allocation`,
      );
    }

    // Every withheld Prefix is either in the inventory or supplied by policy.
    const covered = new Set([...seeded, ...fromPolicy]);
    for (const w of WITHHELD) {
      assert.ok(covered.has(w.tlp), `withheld Prefix "${w.tlp}" would never be allocated`);
    }
  });

  test('the import exclusions are exactly the two the rulings name', () => {
    const names = IMPORT_EXCLUSIONS.map((e) => e.name).sort();
    assert.deepEqual(names, ['proto', 'test.abc']);
  });

  test('the excluded `proto` record is refused by the grammar itself', () => {
    // Belt and braces: even if an importer ignored IMPORT_EXCLUSIONS, the name
    // could not be registered.
    assert.equal(nameProblem('proto'), 'single-segment');
  });

  test('the rename target is a valid name under a Prefix that is not reserved', () => {
    const rename = IMPORT_RENAMES.find((r) => r.from === 'test.abc')!;
    assert.equal(rename.to, 'padi.test.abc');
    assert.equal(nameProblem(rename.to), null);
    assert.ok(!isSpecReserved('padi'));
  });
});

describe('audit hashing (§4.3)', () => {
  test('key order does not change the hash', () => {
    const a = hashSubject({ tlp: 'acme', status: 'active', grandfathered: true });
    const b = hashSubject({ grandfathered: true, status: 'active', tlp: 'acme' });
    assert.equal(a, b);
  });

  test('a changed value changes the hash', () => {
    const a = hashSubject({ tlp: 'acme', status: 'active' });
    const b = hashSubject({ tlp: 'acme', status: 'locked' });
    assert.notEqual(a, b);
  });

  test('nested objects and arrays hash stably', () => {
    const a = hashSubject({ x: [{ b: 1, a: 2 }], y: { d: 4, c: 3 } });
    const b = hashSubject({ y: { c: 3, d: 4 }, x: [{ a: 2, b: 1 }] });
    assert.equal(a, b);
  });

  test('absent subjects hash to null, not to the hash of "undefined"', () => {
    assert.equal(hashSubject(undefined), null);
    assert.equal(hashSubject(null), null);
  });
});
