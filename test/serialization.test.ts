/**
 * §23 testing priority 1 — serialization round-trip goldens.
 *
 *   "Every imported document, both directions, property by property.
 *    A lost flag is a changed contract."
 *
 * The corpus is all 70 real records served by cp.padi.io on 31 August 2026,
 * captured verbatim in test/fixtures/. Not hand-written examples: the actual
 * production data, with all of its inconsistency intact.
 *
 * Half of this suite is written against an INDEPENDENT ORACLE (`rawFlags`),
 * which reads presence off the raw JSON without going through the parser.
 * Comparing the parser against itself would let a parser bug define what
 * "correct" means and pass silently — and a silently inverted role flag is
 * precisely the failure this priority exists to catch.
 *
 * The 2026 serializer is not here yet: GitHub `main` carries the December 2022
 * draft, not the 2026 revision this design is written against, so the target
 * shape is not known well enough to test. The legacy half is fully determined
 * by the corpus and is complete.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  parseCorpus,
  parseProfile,
  parseProperty,
  rawFlags,
  serializeProfile,
  serializeProperty,
} from '../src/profile/legacy.ts';
import { flagsOf, propertiesForRole } from '../src/profile/model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/cp-padi-io-profiles.json');

const rawText = readFileSync(FIXTURE, 'utf8');
const rawCorpus = JSON.parse(rawText) as Record<string, unknown>[];
const corpus = parseCorpus(rawCorpus);

/** Every (record, version, property) triple in the corpus, raw and parsed together. */
function* pairs() {
  for (const [i, raw] of rawCorpus.entries()) {
    const parsed = corpus[i]!;
    const rawVersions = (raw['versions'] ?? []) as Record<string, unknown>[];
    const parsedVersions = parsed.versions ?? [];
    for (const [v, rawVersion] of rawVersions.entries()) {
      const rawProps = (rawVersion['properties'] ?? []) as Record<string, unknown>[];
      const parsedProps = parsedVersions[v]!.properties;
      for (const [p, rawProp] of rawProps.entries()) {
        yield {
          where: `${parsed.name}.versions[${v}].properties[${p}]`,
          raw: rawProp,
          parsed: parsedProps[p]!,
        };
      }
    }
  }
}

describe('the corpus is what we think it is', () => {
  test('70 records, 303 properties', () => {
    assert.equal(rawCorpus.length, 70);
    assert.equal(corpus.length, 70);
    assert.equal([...pairs()].length, 303);
  });

  test('the presence counts match the 31 Aug 2026 measurement', () => {
    // If these drift, cp.padi.io changed and the fixture is stale — which is a
    // thing to know before trusting anything else in this file.
    let server = 0;
    let required = 0;
    let propagate = 0;
    for (const { raw } of pairs()) {
      if ('server' in raw) server++;
      if ('required' in raw) required++;
      if ('propagate' in raw) propagate++;
    }
    assert.equal(server, 186, 'server presence count changed');
    assert.equal(required, 171, 'required presence count changed');
    assert.equal(propagate, 278, 'propagate presence count changed');
  });

  test('presence is the ENTIRE signal — the value is always null', () => {
    for (const { where, raw } of pairs()) {
      for (const key of ['server', 'required', 'propagate']) {
        if (key in raw) {
          assert.equal(raw[key], null, `${where}.${key} is not null; the encoding has changed`);
        }
      }
    }
  });

  test('no property carries a `client` key — absent `server` means consumer', () => {
    for (const { where, raw } of pairs()) {
      assert.ok(!('client' in raw), `${where} has a client key; the role encoding is not what we assumed`);
    }
  });

  test('a legacy version object carries only `properties` — no number, status or date', () => {
    for (const raw of rawCorpus) {
      for (const version of (raw['versions'] ?? []) as Record<string, unknown>[]) {
        assert.deepEqual(
          Object.keys(version),
          ['properties'],
          `${raw['name']} has a version with unexpected keys`,
        );
      }
    }
  });
});

describe('every flag survives parsing — property by property, against the raw JSON', () => {
  test('all 303 properties agree with the independent oracle', () => {
    let checked = 0;
    for (const { where, raw, parsed } of pairs()) {
      const expected = rawFlags(raw);
      assert.equal(parsed.role, expected.role, `${where}: role`);
      assert.equal(parsed.mandatory, expected.mandatory, `${where}: mandatory`);
      assert.equal(parsed.propagate, expected.propagate, `${where}: propagate`);
      checked++;
    }
    assert.equal(checked, 303);
  });

  test('name and description are carried verbatim', () => {
    for (const { where, raw, parsed } of pairs()) {
      assert.equal(parsed.name, raw['name'], `${where}: name`);
      assert.equal(parsed.description, raw['description'], `${where}: description`);
    }
  });

  test('the provider/consumer split adds back up', () => {
    for (const profile of corpus) {
      for (const version of profile.versions ?? []) {
        const provider = propertiesForRole(version, 'provider');
        const consumer = propertiesForRole(version, 'consumer');
        assert.equal(provider.length + consumer.length, version.properties.length, profile.name);
      }
    }
  });
});

describe('round trip — legacy → model → legacy', () => {
  test('every record re-serializes to the same semantic content', () => {
    for (const [i, raw] of rawCorpus.entries()) {
      const reserialized = serializeProfile(corpus[i]!);
      const reparsed = parseProfile(reserialized);
      assert.deepEqual(
        reparsed,
        corpus[i],
        `${raw['name']} did not survive a round trip through the model`,
      );
    }
  });

  test('every flag survives the round trip, checked against the ORIGINAL raw JSON', () => {
    // The end-to-end claim: a flag read off the bytes cp.padi.io served is the
    // same flag present in the bytes we would serve back.
    let checked = 0;
    for (const [i, raw] of rawCorpus.entries()) {
      const reserialized = serializeProfile(corpus[i]!) as Record<string, unknown>;
      const rawVersions = (raw['versions'] ?? []) as Record<string, unknown>[];
      const outVersions = (reserialized['versions'] ?? []) as Record<string, unknown>[];

      for (const [v, rawVersion] of rawVersions.entries()) {
        const rawProps = (rawVersion['properties'] ?? []) as Record<string, unknown>[];
        const outProps = (outVersions[v]!['properties'] ?? []) as Record<string, unknown>[];
        assert.equal(outProps.length, rawProps.length);

        for (const [p, rawProp] of rawProps.entries()) {
          const outProp = outProps[p]!;
          const where = `${raw['name']}.versions[${v}].properties[${p}]`;
          // Compare presence to presence, not value to value.
          for (const key of ['server', 'required', 'propagate']) {
            assert.equal(
              key in outProp,
              key in rawProp,
              `${where}: "${key}" presence flipped — this is a changed contract`,
            );
          }
          checked++;
        }
      }
    }
    assert.equal(checked, 303);
  });

  test('absence at the top level is preserved as absence, never invented as null', () => {
    // 19 records have no `comment`, 4 no `company`, 1 no `title`, 2 no `versions`.
    // Emitting `"company": null` for a record that never had the key would be a
    // different document.
    const optional = ['title', 'comment', 'company', 'website', 'server', 'client', 'modified', 'versions'];
    for (const [i, raw] of rawCorpus.entries()) {
      const out = serializeProfile(corpus[i]!) as Record<string, unknown>;
      for (const key of optional) {
        assert.equal(key in out, key in raw, `${raw['name']}: "${key}" presence flipped at the top level`);
      }
    }
  });

  test('serialization is idempotent', () => {
    for (const profile of corpus) {
      const once = serializeProfile(profile);
      const twice = serializeProfile(parseProfile(once));
      assert.deepEqual(twice, once, `${profile.name} is not stable under re-serialization`);
    }
  });

  test('the records with no `versions` key keep having no `versions` key', () => {
    const without = rawCorpus.filter((r) => !('versions' in r));
    assert.equal(without.length, 2);
    for (const raw of without) {
      const profile = corpus.find((p) => p.name === raw['name'])!;
      assert.equal(profile.versions, undefined);
      assert.ok(!('versions' in serializeProfile(profile)));
    }
  });

  test('the two records with two versions keep both, in order', () => {
    const twoVersions = corpus.filter((p) => (p.versions ?? []).length === 2);
    assert.equal(twoVersions.length, 2);
    assert.deepEqual(twoVersions.map((p) => p.name).sort(), ['padi.game.presence', 'proto.something.x']);
  });
});

describe('the hazard, stated as tests', () => {
  // These do not exercise the corpus. They pin the specific mistakes that would
  // silently destroy the encoding, so that a future refactor fails loudly.

  test('a null value is a set flag, not an absent one', () => {
    const provider = parseProperty({ server: null, name: 'x', description: 'd' }, 't');
    const consumer = parseProperty({ name: 'x', description: 'd' }, 't');
    assert.equal(provider.role, 'provider');
    assert.equal(consumer.role, 'consumer');
  });

  test('truthiness would invert 186 provider flags — presence must be tested with `in`', () => {
    const raw = { server: null, name: 'x', description: 'd', required: null, propagate: null };
    // The bug: `if (raw.server)` is false for a present-and-null key.
    assert.equal(Boolean((raw as Record<string, unknown>)['server']), false);
    // The parser must not agree with that.
    assert.equal(parseProperty(raw, 't').role, 'provider');
    assert.equal(parseProperty(raw, 't').mandatory, true);
    assert.equal(parseProperty(raw, 't').propagate, true);
  });

  test('stripping nulls before parsing destroys all three flags', () => {
    const raw = { server: null, name: 'x', description: 'd', required: null, propagate: null };
    const stripped = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
    const intact = parseProperty(raw, 't');
    const damaged = parseProperty(stripped, 't');
    assert.equal(flagsOf(intact), 'provider|mandatory|propagate');
    assert.equal(flagsOf(damaged), 'consumer|optional|no-propagate');
    // Every one of the three inverted. Recorded here so the consequence is
    // written down rather than discovered.
  });

  test('serializing a set flag writes the key with a null value', () => {
    const out = serializeProperty({
      name: 'x',
      description: 'd',
      role: 'provider',
      mandatory: true,
      propagate: true,
    });
    assert.equal(out['server'], null);
    assert.equal(out['required'], null);
    assert.equal(out['propagate'], null);
    assert.ok('server' in out && 'required' in out && 'propagate' in out);
  });

  test('serializing an unset flag omits the key entirely', () => {
    const out = serializeProperty({
      name: 'x',
      description: 'd',
      role: 'consumer',
      mandatory: false,
      propagate: false,
    });
    assert.ok(!('server' in out));
    assert.ok(!('required' in out));
    assert.ok(!('propagate' in out));
  });

  test('top-level `server` is a capability title, not a role flag', () => {
    // Same key name, different meaning one level down. The trap this format sets.
    const profile = parseProfile({
      name: 'a.b',
      server: 'Serves consumption data',
      versions: [{ properties: [{ server: null, name: 'x', description: 'd' }] }],
    });
    assert.equal(profile.providerTitle, 'Serves consumption data');
    assert.equal(profile.versions![0]!.properties[0]!.role, 'provider');
  });
});

describe('byte-identity is NOT claimed, and here is why', () => {
  test('the corpus uses 13 top-level and 23 property key orders', () => {
    const top = new Set(rawCorpus.map((r) => Object.keys(r).join(',')));
    const prop = new Set([...pairs()].map(({ raw }) => Object.keys(raw).join(',')));
    assert.equal(top.size, 13);
    assert.equal(prop.size, 23);

    // A semantic model can reproduce one order, not thirteen. This is exactly
    // why §12.2 stores `served_bytes` verbatim: spec §9.3 requires that the
    // same name and version never be answered with differing content, and that
    // guarantee comes from replaying stored bytes, not from a canonical
    // serializer. Recorded as a test so the reasoning survives.
  });

  test('re-serialized output is semantically equal but not byte-equal', () => {
    const differing = rawCorpus.filter(
      (raw, i) => JSON.stringify(serializeProfile(corpus[i]!)) !== JSON.stringify(raw),
    );
    assert.ok(differing.length > 0, 'if this is ever 0, key order became canonical upstream');
    // And yet every one of them round-trips semantically — proven above.
  });
});
