import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  formatReference,
  isName,
  isTlp,
  nameProblem,
  parseReference,
  scopeCovers,
  tlpOf,
} from '../src/names.ts';

describe('name grammar (§3.1, spec §7.1–§7.2)', () => {
  test('a Profile name needs at least two segments', () => {
    assert.equal(nameProblem('acme.meter.flow'), null);
    assert.equal(nameProblem('acme.meter'), null);
    assert.equal(nameProblem('acme'), 'single-segment');
  });

  test('no parent need exist — the spec places no requirement on shape or depth', () => {
    // acme.meter.flow is registrable whether or not acme.meter exists.
    // The grammar has no opinion, which is the point: refusing on that ground
    // would breach spec §7.1.
    assert.ok(isName('acme.meter.flow'));
    assert.ok(isName('a.b.c.d.e.f.g.h'));
  });

  test('uppercase is rejected, never folded — names compare exactly (spec §7.2)', () => {
    assert.equal(nameProblem('Acme.Meter'), 'not-lowercase');
    assert.equal(nameProblem('acme.METER'), 'not-lowercase');
  });

  test('hyphens are legal inside a segment but not at its edges', () => {
    assert.equal(nameProblem('acme.hot-water'), null);
    assert.equal(nameProblem('acme.-water'), 'leading-hyphen');
    assert.equal(nameProblem('acme.water-'), 'trailing-hyphen');
  });

  test('characters outside a-z 0-9 hyphen are rejected', () => {
    assert.equal(nameProblem('acme.me_ter'), 'bad-character');
    assert.equal(nameProblem('acme.me ter'), 'bad-character');
    assert.equal(nameProblem('acme.métre'), 'bad-character');
  });

  test('empty segments are rejected', () => {
    assert.equal(nameProblem('acme..flow'), 'empty-segment');
    assert.equal(nameProblem('acme.'), 'empty-segment');
    assert.equal(nameProblem('.acme'), 'empty-segment');
  });

  test('operational limits are enforced', () => {
    assert.equal(nameProblem('a.' + 'x'.repeat(LIMITS.maxSegmentBytes + 1)), 'segment-too-long');
    assert.equal(nameProblem(Array(LIMITS.maxSegments + 2).fill('ab').join('.')), 'too-many-segments');

    const long = 'a.' + Array(20).fill('x'.repeat(8)).join('.');
    assert.equal(nameProblem(long.slice(0, LIMITS.maxNameBytes + 20)), 'name-too-long');
  });

  test('a Top Level Prefix is exactly one segment', () => {
    assert.ok(isTlp('acme'));
    assert.ok(!isTlp('acme.meter'));
    assert.ok(!isTlp(''));
  });

  test('tlpOf takes the first segment', () => {
    assert.equal(tlpOf('acme.meter.flow'), 'acme');
    assert.equal(tlpOf('acme'), 'acme');
  });

  test('the real cp.padi.io names all pass', () => {
    for (const name of [
      'padi.tstat.basic',
      'ibb.zone.data.temperature.history.v1',
      'proto.commerce.supply',
      'kubecns.application',
      'onuma.studio',
      'c4sb.idl.proto',
    ]) {
      assert.equal(nameProblem(name), null, name);
    }
  });

  test('the bare `proto` record from cp.padi.io is not a registrable name', () => {
    // §10.2 ruling 2 — the one import that the grammar itself refuses.
    assert.equal(nameProblem('proto'), 'single-segment');
  });
});

describe('scope containment (§8.3) — string prefix, not a tree', () => {
  test('a scope covers itself and anything beneath it', () => {
    assert.ok(scopeCovers('ashrae.135', 'ashrae.135'));
    assert.ok(scopeCovers('ashrae.135', 'ashrae.135.bacnet'));
    assert.ok(scopeCovers('ashrae.135', 'ashrae.135.bacnet.mstp'));
  });

  test('the segment boundary is respected — 135 does not cover 1350', () => {
    // The failure mode a naive startsWith() produces, and the reason this is a
    // function rather than an inline expression.
    assert.ok(!scopeCovers('ashrae.135', 'ashrae.1350'));
    assert.ok(!scopeCovers('ashrae.135', 'ashrae.135x'));
  });

  test('a scope does not cover its own parent or a sibling', () => {
    assert.ok(!scopeCovers('ashrae.135', 'ashrae'));
    assert.ok(!scopeCovers('ashrae.135', 'ashrae.223'));
  });

  test('no interior name need exist for a scope to cover', () => {
    // `ashrae.135` itself may never be registered; the scope still works.
    assert.ok(scopeCovers('ashrae.135', 'ashrae.135.working-group.draft-a'));
  });
});

describe('references (spec §7.2)', () => {
  test('a one-segment reference denotes an allocation, never a Profile', () => {
    assert.deepEqual(parseReference('cp:acme'), { kind: 'allocation', tlp: 'acme' });
  });

  test('a dotted reference is a Profile, with an optional version', () => {
    assert.deepEqual(parseReference('cp:acme.meter.flow'), {
      kind: 'profile',
      name: 'acme.meter.flow',
      tlp: 'acme',
      version: null,
    });
    assert.deepEqual(parseReference('cp:acme.meter.flow:2'), {
      kind: 'profile',
      name: 'acme.meter.flow',
      tlp: 'acme',
      version: 2,
    });
    assert.deepEqual(parseReference('cp:acme.meter.flow:draft'), {
      kind: 'profile',
      name: 'acme.meter.flow',
      tlp: 'acme',
      version: 'draft',
    });
  });

  test('integers and the reserved token `draft` never collide', () => {
    const asInteger = parseReference('cp:a.b:12');
    const asDraft = parseReference('cp:a.b:draft');
    assert.equal(asInteger.kind === 'profile' && asInteger.version, 12);
    assert.equal(asDraft.kind === 'profile' && asDraft.version, 'draft');
  });

  test('uppercase CP: is documentary and is refused, not folded', () => {
    assert.throws(() => parseReference('CP:acme.meter'), /documentary/);
  });

  test('a version on an allocation reference is a category error', () => {
    assert.throws(() => parseReference('cp:acme:2'), /allocation, which has no versions/);
  });

  test('a bare name without the cp: marker is not a reference', () => {
    assert.throws(() => parseReference('acme.meter'), /"cp:" marker/);
  });

  test('version 0 and non-integer versions are refused', () => {
    assert.throws(() => parseReference('cp:a.b:0'), /versions are integers assigned from 1/);
    assert.throws(() => parseReference('cp:a.b:v1'), /integer or the reserved token/);
    assert.throws(() => parseReference('cp:a.b:1.2'), /integer or the reserved token/);
  });

  test('round-trips', () => {
    for (const ref of ['cp:acme', 'cp:acme.meter.flow', 'cp:acme.meter.flow:7']) {
      assert.equal(formatReference(parseReference(ref)), ref);
    }
  });
});
