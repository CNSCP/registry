/**
 * §23 testing priority 1, the other direction — the 2026 serialization.
 *
 * The anchor is the specification's own worked example (§6.6, `cp:example.light:1`).
 * If this file's serializer cannot reproduce that document byte for byte, the
 * mapper is wrong and nothing built on it can be trusted.
 *
 * The corpus tests then answer the question Phase 0 actually turns on: how many
 * of the 70 deployed records can become conforming Profiles? The answer is
 * none, and the tests say so precisely rather than approximately.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseCorpus } from '../src/profile/legacy.ts';
import { parseProfileVersion, serializeProfileVersion, parseYesNo, yesNo } from '../src/profile/spec2026.ts';
import {
  REQUIRED_HEADER_FIELDS,
  checkProfileVersion,
  missingHeaderFields,
  summarize,
} from '../src/profile/conformance.ts';
import type { Profile, Property, Role } from '../src/profile/model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(
  JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')),
);

/** Spec §6.6, transcribed exactly. */
const WORKED_EXAMPLE = {
  Header: {
    'Name': 'example.light',
    'Version': '1',
    'Pub Date': '2026-06-15',
    'Status': 'Published',
    'Owner': 'Example Profiles Organization',
    'Title': 'Simple Light Control',
    'Provider': 'Switch',
    'Consumer': 'Light',
    'Description':
      'Connects a controlling device to a controllable light. The Provider supplies the desired state; the Consumer acts on it and reports the state achieved.',
    'Website': 'https://profiles.example.org/light/1',
  },
  Properties: {
    Provider: [
      {
        Name: 'state',
        Mandatory: 'yes',
        Propagate: 'yes',
        Description: 'The desired light level as a fraction, 0 to 1; 0 is off, 1 is fully on.',
        Sample: '0.75',
      },
      {
        Name: 'color',
        Mandatory: 'no',
        Propagate: 'yes',
        Description: 'The desired color of the light.',
        Sample: '#FFAA00',
      },
    ],
    Consumer: [
      {
        Name: 'actual',
        Mandatory: 'yes',
        Propagate: 'yes',
        Description: 'The light level actually achieved, as a fraction, 0 to 1.',
        Sample: '0.75',
      },
      {
        Name: 'power',
        Mandatory: 'no',
        Propagate: 'no',
        Description: 'Present power draw, in watts.',
        Sample: '8.5',
      },
    ],
  },
};

describe('the specification’s own worked example (§6.6)', () => {
  test('parses', () => {
    const profile = parseProfileVersion(WORKED_EXAMPLE as never);
    assert.equal(profile.name, 'example.light');
    assert.equal(profile.version, 1);
    assert.equal(profile.status, 'Published');
    assert.equal(profile.pubDate, '2026-06-15');
    assert.equal(profile.owner, 'Example Profiles Organization');
    assert.equal(profile.providerTitle, 'Switch');
    assert.equal(profile.consumerTitle, 'Light');
    assert.equal(profile.versions![0]!.properties.length, 4);
  });

  test('round-trips byte for byte', () => {
    // Achievable here and not for the legacy corpus, because the spec fixes
    // this shape's field order where five years of deployment did not.
    const reserialized = serializeProfileVersion(parseProfileVersion(WORKED_EXAMPLE as never));
    assert.deepEqual(reserialized, WORKED_EXAMPLE);
    assert.equal(JSON.stringify(reserialized), JSON.stringify(WORKED_EXAMPLE));
  });

  test('role is structural — the grouping IS the role (§6.3)', () => {
    const profile = parseProfileVersion(WORKED_EXAMPLE as never);
    const props = profile.versions![0]!.properties;
    assert.deepEqual(
      props.filter((p) => p.role === 'provider').map((p) => p.name),
      ['state', 'color'],
    );
    assert.deepEqual(
      props.filter((p) => p.role === 'consumer').map((p) => p.name),
      ['actual', 'power'],
    );
    // No Property carries its own role field — that is the whole point of §6.3.
    const out = serializeProfileVersion(profile) as { Properties: { Provider: object[] } };
    for (const p of out.Properties.Provider) {
      assert.ok(!('Role' in p) && !('Source' in p), 'role must not be repeated on a Property');
    }
  });

  test('the §6.6 NOTE holds: three of four role/propagate combinations appear', () => {
    const props = parseProfileVersion(WORKED_EXAMPLE as never).versions![0]!.properties;
    const combos = new Set(props.map((p) => `${p.role}/${p.propagate}`));
    assert.equal(combos.size, 3);
    assert.ok(!combos.has('provider/false'), 'the absent combination is provider with Propagate unset');
  });
});

describe('flags are the strings "yes"/"no" (§6.6)', () => {
  test('booleans are refused, not coerced', () => {
    assert.throws(() => parseYesNo(true, 'x'), /expected "yes" or "no"/);
    assert.throws(() => parseYesNo(false, 'x'), /expected "yes" or "no"/);
    assert.throws(() => parseYesNo(null, 'x'), /expected "yes" or "no"/);
    assert.throws(() => parseYesNo('true', 'x'), /expected "yes" or "no"/);
  });

  test('and are emitted as strings', () => {
    assert.equal(yesNo(true), 'yes');
    assert.equal(yesNo(false), 'no');
    assert.equal(typeof yesNo(true), 'string');
  });
});

describe('Version is an integer rendered as a string (§6.2, §6.6)', () => {
  test('a non-integer Version is refused', () => {
    for (const bad of ['1.0', 'v1', 'one', '']) {
      const doc = { Header: { ...WORKED_EXAMPLE.Header, Version: bad }, Properties: {} };
      assert.throws(() => parseProfileVersion(doc as never), /integer as a string/, `Version "${bad}"`);
    }
  });

  test('the model holds a number; the Header renders a string', () => {
    const profile = parseProfileVersion(WORKED_EXAMPLE as never);
    assert.equal(typeof profile.version, 'number');
    const out = serializeProfileVersion(profile) as { Header: Record<string, unknown> };
    assert.equal(out.Header['Version'], '1');
    assert.equal(typeof out.Header['Version'], 'string');
  });

  test('an absent Version means Draft and is not defaulted to 1 (§6.4)', () => {
    const { Version: _v, 'Pub Date': _p, ...rest } = WORKED_EXAMPLE.Header;
    const doc = { Header: { ...rest, Status: 'Draft' }, Properties: {} };
    const profile = parseProfileVersion(doc as never);
    assert.equal(profile.version, undefined);
    const out = serializeProfileVersion({ ...profile, versions: [{ properties: [] }] }) as {
      Header: Record<string, unknown>;
    };
    assert.ok(!('Version' in out.Header), 'a Draft must not be given a version number');
  });

  test('an unknown Status is refused', () => {
    const doc = { Header: { ...WORKED_EXAMPLE.Header, Status: 'Active' }, Properties: {} };
    // "Active" is the 2022 draft's value; the 2026 revision has Draft /
    // Published / Deprecated. Accepting it would silently import stale state.
    assert.throws(() => parseProfileVersion(doc as never), /expected one of Draft, Published, Deprecated/);
  });
});

describe('conformance of the deployed corpus (§9.4) — the Phase 0 finding', () => {
  const reports = corpus.map((p) => checkProfileVersion(p, 0));

  test('all ten Header fields are REQUIRED (§6.4)', () => {
    assert.equal(REQUIRED_HEADER_FIELDS.length, 10);
  });

  test('NOT ONE deployed record is a conforming Profile', () => {
    const summary = summarize(reports);
    assert.equal(summary.total, 70);
    assert.equal(summary.conforming, 0);
  });

  test('Version, Pub Date and Status are missing from all 70 — the legacy format has no source', () => {
    for (const profile of corpus) {
      const missing = missingHeaderFields(profile);
      assert.ok(missing.includes('Version'), `${profile.name}: Version`);
      assert.ok(missing.includes('Pub Date'), `${profile.name}: Pub Date`);
      assert.ok(missing.includes('Status'), `${profile.name}: Status`);
    }
  });

  test('the six mappable fields are missing in the measured proportions', () => {
    const count = (field: string) =>
      corpus.filter((p) => missingHeaderFields(p).includes(field as never)).length;
    assert.equal(count('Description'), 19);
    assert.equal(count('Consumer'), 16);
    assert.equal(count('Provider'), 15);
    assert.equal(count('Website'), 14);
    assert.equal(count('Owner'), 4);
    assert.equal(count('Title'), 1);
  });

  test('38 of 70 could fill all six mappable fields, if the other four were resolved', () => {
    const mappable = ['Owner', 'Title', 'Provider', 'Consumer', 'Description', 'Website'];
    const complete = corpus.filter(
      (p) => !missingHeaderFields(p).some((f) => mappable.includes(f)),
    );
    assert.equal(complete.length, 38);
  });

  test('no Sample anywhere — 0 of 303 properties', () => {
    let total = 0;
    let withSample = 0;
    for (const profile of corpus) {
      for (const version of profile.versions ?? []) {
        for (const property of version.properties) {
          total++;
          if (property.sample !== undefined) withSample++;
        }
      }
    }
    assert.equal(total, 303);
    assert.equal(withSample, 0);
  });

  test('the Sample reading changes the verdict for every property, so it is a flag not a default', () => {
    const lenient = checkProfileVersion(corpus[0]!, 0, { requireSample: false });
    const strict = checkProfileVersion(corpus[0]!, 0, { requireSample: true });
    assert.ok(strict.findings.length > lenient.findings.length);
  });

  test('property names ARE unique across both roles — this part of §9.4 already passes', () => {
    for (const report of reports) {
      assert.ok(
        !report.findings.some((f) => f.kind === 'duplicate-property-name'),
        `${report.name} has a duplicate property name`,
      );
    }
  });

  test('test.abc is flagged for its reserved Prefix as well (§7.1)', () => {
    const report = reports.find((r) => r.name === 'test.abc')!;
    assert.ok(report.findings.some((f) => f.kind === 'prefix-reserved'));
  });

  test('the bare `proto` record is flagged as an invalid name (§7.2)', () => {
    const report = reports.find((r) => r.name === 'proto')!;
    assert.ok(report.findings.some((f) => f.kind === 'name-invalid'));
  });
});

describe('legacy → model → 2026, the flags that must survive both hops', () => {
  test('presence-encoded flags become "yes"/"no" without inversion — all 303', () => {
    // Every version, not just the first: two records carry two versions, and
    // the 8 properties in their second version are as much a contract as the
    // rest. Checking versions[0] alone silently covers 295 of 303.
    let checked = 0;

    for (const profile of corpus) {
      const versions = profile.versions ?? [];
      for (let v = 0; v < versions.length; v++) {
        const sourceProps: Property[] = versions[v]!.properties;
        const out = serializeProfileVersion(profile, v) as {
          Properties: { Provider: Record<string, unknown>[]; Consumer: Record<string, unknown>[] };
        };

        const groups: [Role, Record<string, unknown>[]][] = [
          ['provider', out.Properties.Provider],
          ['consumer', out.Properties.Consumer],
        ];

        for (const [role, group] of groups) {
          for (const emitted of group) {
            const source = sourceProps.find((p) => p.name === emitted['Name']);
            assert.ok(source, `${profile.name} v${v}: emitted an unknown property`);
            assert.equal(source.role, role, `${profile.name}.${source.name}: role moved group`);
            assert.equal(emitted['Mandatory'], yesNo(source.mandatory), `${profile.name}.${source.name}`);
            assert.equal(emitted['Propagate'], yesNo(source.propagate), `${profile.name}.${source.name}`);
            checked++;
          }
        }
      }
    }

    assert.equal(checked, 303, 'every property in every version must be covered');
  });

  test('a Property with no Sample omits the key rather than inventing an empty one', () => {
    const withProps = corpus.find((p) => (p.versions?.[0]?.properties.length ?? 0) > 0)!;
    const out = serializeProfileVersion(withProps, 0) as {
      Properties: { Provider: Record<string, unknown>[]; Consumer: Record<string, unknown>[] };
    };
    for (const group of [out.Properties.Provider, out.Properties.Consumer]) {
      for (const property of group) {
        assert.ok(!('Sample' in property), 'absence is the truth; an empty string would be a claim');
      }
    }
  });

  test('round trip through 2026 preserves every flag', () => {
    for (const profile of corpus) {
      if (!profile.versions?.length) continue;
      const back = parseProfileVersion(serializeProfileVersion(profile, 0) as never);
      const original = profile.versions[0]!.properties;
      const returned = back.versions![0]!.properties;

      assert.equal(returned.length, original.length, profile.name);
      for (const source of original) {
        const match = returned.find((p) => p.name === source.name)!;
        assert.equal(match.role, source.role, `${profile.name}.${source.name}: role`);
        assert.equal(match.mandatory, source.mandatory, `${profile.name}.${source.name}: mandatory`);
        assert.equal(match.propagate, source.propagate, `${profile.name}.${source.name}: propagate`);
        assert.equal(match.description, source.description);
      }
    }
  });

  test('property ORDER is not recoverable once the roles are split', () => {
    // Legacy holds one interleaved array; 2026 holds two grouped ones. A record
    // whose properties alternate roles cannot come back in its original order —
    // another reason §12.2 stores served_bytes rather than regenerating them.
    // Specifically: a record where a CONSUMER property precedes a PROVIDER one.
    // A record that merely changes role once, provider-then-consumer, is
    // already in grouped order and survives the split unchanged — which is why
    // the first version of this test found a record and proved nothing.
    const interleaved = corpus.find((p) => {
      const props = p.versions?.[0]?.properties ?? [];
      const firstConsumer = props.findIndex((x) => x.role === 'consumer');
      const lastProvider = props.map((x) => x.role).lastIndexOf('provider');
      return firstConsumer !== -1 && lastProvider !== -1 && firstConsumer < lastProvider;
    });
    assert.ok(interleaved, 'expected a record whose consumer property precedes a provider one');

    const original = interleaved!.versions![0]!.properties.map((p) => p.name);
    const returned = parseProfileVersion(
      serializeProfileVersion(interleaved!, 0) as never,
    ).versions![0]!.properties.map((p) => p.name);

    assert.notDeepEqual(returned, original);
    assert.deepEqual([...returned].sort(), [...original].sort(), 'nothing lost, only reordered');
  });
});

/** A complete Profile, for the positive case the corpus cannot supply. */
function conformingProfile(): Profile {
  return {
    name: 'acme.meter.flow',
    version: 1,
    pubDate: '2026-08-31',
    status: 'Published',
    owner: 'Acme Corp',
    title: 'Flow meter',
    providerTitle: 'Meter',
    consumerTitle: 'Reader',
    description: 'A flow meter and whatever reads it.',
    website: 'https://acme.example/flow',
    versions: [
      {
        properties: [
          {
            name: 'rate',
            description: 'Flow rate in litres per minute.',
            role: 'provider',
            mandatory: true,
            propagate: true,
            sample: '12.5',
          },
        ],
      },
    ],
  };
}

describe('the positive case', () => {
  test('a complete Profile conforms under both Sample readings', () => {
    const profile = conformingProfile();
    assert.equal(checkProfileVersion(profile, 0, { requireSample: false }).conforms, true);
    assert.equal(checkProfileVersion(profile, 0, { requireSample: true }).conforms, true);
  });

  test('removing any one REQUIRED Header field breaks conformance', () => {
    const fields = ['owner', 'title', 'providerTitle', 'consumerTitle', 'description', 'website'] as const;
    for (const field of fields) {
      const damaged = { ...conformingProfile() };
      delete damaged[field];
      const report = checkProfileVersion(damaged, 0);
      assert.equal(report.conforms, false, `removing ${field} should break conformance`);
    }
  });

  test('a Draft is excused Version and Pub Date, and nothing else (§6.4)', () => {
    const draft: Profile = { ...conformingProfile(), status: 'Draft' };
    delete draft.version;
    delete draft.pubDate;
    assert.deepEqual(missingHeaderFields(draft), []);

    // The same absences without Draft status are findings.
    const notDraft: Profile = { ...draft, status: 'Published' };
    assert.deepEqual(missingHeaderFields(notDraft).sort(), ['Pub Date', 'Version']);
  });
});
