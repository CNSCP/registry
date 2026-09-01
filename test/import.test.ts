/**
 * The Phase 0 import plan — design §10.2 rulings and §10.4 policy.
 *
 * Run against all 70 real records. The assertions that matter most are the
 * negative ones: that nothing is invented. A test suite for an importer is
 * mostly a guard against helpfulness — the temptation to fill an empty Owner
 * with the Prefix holder's name, or a missing Description with the Title, is
 * exactly what §10.4 forbids, and it would be permanent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseCorpus } from '../src/profile/legacy.ts';
import { planImport, planRecord } from '../src/profile/import.ts';
import { serializeProfileVersion } from '../src/profile/spec2026.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(
  JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')),
);
const plan = planImport(corpus);

describe('the §10.2 rulings, applied to the real corpus', () => {
  test('the bare `proto` record is excluded, on the grammar not a name list', () => {
    const decision = planRecord(corpus.find((p) => p.name === 'proto')!);
    assert.equal(decision.action, 'exclude');
    assert.match(decision.action === 'exclude' ? decision.reason : '', /never a Profile/);
  });

  test('test.abc is renamed to padi.test.abc and still imported', () => {
    const decision = planRecord(corpus.find((p) => p.name === 'test.abc')!);
    assert.equal(decision.action, 'rename');
    if (decision.action !== 'rename') return;
    assert.equal(decision.to, 'padi.test.abc');
    assert.ok(decision.versions.length > 0, 'the rename must not lose the record');
    assert.equal(decision.versions[0]!.profile.name, 'padi.test.abc');
    // And the audit trail keeps the old name, so the record can still be traced
    // back to what cp.padi.io served.
    assert.equal(decision.versions[0]!.sourceName, 'test.abc');
  });

  test('every other imported version keeps its name as its source name', () => {
    for (const version of plan.imported) {
      if (version.name === 'padi.test.abc') continue;
      assert.equal(version.sourceName, version.name, `${version.name} has an unexpected rename`);
    }
  });

  test('exactly one exclusion and one rename across 70 records', () => {
    assert.deepEqual(plan.excluded.map((e) => e.name), ['proto']);
    assert.deepEqual(plan.renamed, [{ from: 'test.abc', to: 'padi.test.abc' }]);
  });

  test('every other record keeps its name — 69 of 70', () => {
    assert.equal(plan.registeredNames.length, 69);
    assert.ok(!plan.registeredNames.includes('proto'));
    assert.ok(!plan.registeredNames.includes('test.abc'));
    assert.ok(plan.registeredNames.includes('padi.test.abc'));
  });

  test('a record with no version content is REGISTERED, not dropped (§12.1)', () => {
    // padi.appliance and padi.device carry no `versions` key. An earlier cut of
    // the importer tracked only published versions and silently lost both —
    // releasing two names that are in the namespace today. §12.1: "a row with
    // zero published versions is a registered name with a Draft and nothing
    // else — which is exactly what the Registry reports."
    assert.deepEqual(plan.registeredWithoutVersions.sort(), ['padi.appliance', 'padi.device']);
    for (const name of plan.registeredWithoutVersions) {
      assert.ok(plan.registeredNames.includes(name), `${name} lost its registration`);
      assert.ok(
        !plan.imported.some((v) => v.profile.name === name),
        `${name} should publish no version`,
      );
    }
  });

  test('registered names account for every record that was not excluded', () => {
    const withVersions = new Set(plan.imported.map((v) => v.profile.name));
    assert.equal(withVersions.size + plan.registeredWithoutVersions.length, plan.registeredNames.length);
    assert.equal(plan.registeredNames.length + plan.excluded.length, 70);
  });

  test('version numbers are assigned by array position, from 1 (spec §6.2)', () => {
    const twoVersions = plan.imported.filter((v) => v.profile.name === 'padi.game.presence');
    assert.deepEqual(twoVersions.map((v) => v.version), [1, 2]);
    for (const version of plan.imported) {
      assert.ok(version.version >= 1, `${version.name} got version ${version.version}`);
    }
  });

  test('the two records with no versions produce no published versions', () => {
    const noVersions = corpus.filter((p) => p.versions === undefined);
    assert.equal(noVersions.length, 2);
    for (const record of noVersions) {
      const decision = planRecord(record);
      assert.equal(decision.action === 'import' ? decision.versions.length : -1, 0);
    }
  });
});

describe('nothing is invented — the rule §10.4 exists to enforce', () => {
  test('a record with no Owner is imported with no Owner', () => {
    const ownerless = plan.imported.filter((v) => v.profile.owner === undefined);
    assert.ok(ownerless.length > 0, 'expected records without a company field');
    for (const version of ownerless) {
      assert.equal(version.profile.owner, undefined, `${version.name} acquired an Owner`);
      assert.ok(
        version.missingHeaderFields.includes('Owner'),
        `${version.name} lacks an Owner but does not say so`,
      );
    }
  });

  test('no absent Header field is filled from another field', () => {
    for (const version of plan.imported) {
      // `sourceName` is what cp.padi.io served it as; `name` is what it will be
      // published as. They differ only for the §10.2 ruling 1 rename.
      const source = corpus.find((p) => p.name === version.sourceName);
      assert.ok(source, `no source record for ${version.sourceName}`);
      const header = version.profile;
      // Each of these was either present in the source or is still absent.
      // Nothing was borrowed from a neighbour.
      if (source.description === undefined) assert.equal(header.description, undefined);
      if (source.website === undefined) assert.equal(header.website, undefined);
      if (source.providerTitle === undefined) assert.equal(header.providerTitle, undefined);
      if (source.consumerTitle === undefined) assert.equal(header.consumerTitle, undefined);
    }
  });

  test('no Sample is synthesized for any of the 303 properties', () => {
    for (const version of plan.imported) {
      for (const property of version.content.properties) {
        assert.equal(property.sample, undefined, `${version.name}.${property.name} acquired a Sample`);
      }
    }
  });

  test('a Sample is never emitted as an empty string either', () => {
    // "Sample": "" would assert the author supplied an empty sample. Absence
    // is the truth and stays absence on the wire.
    for (const version of plan.imported.slice(0, 20)) {
      const out = serializeProfileVersion(version.profile, 0) as {
        Properties: { Provider: Record<string, unknown>[]; Consumer: Record<string, unknown>[] };
      };
      for (const group of [out.Properties.Provider, out.Properties.Consumer]) {
        for (const property of group) assert.ok(!('Sample' in property));
      }
    }
  });
});

describe('the three gaps that DO get resolved (§10.4)', () => {
  test('Status is Published — they are in service', () => {
    for (const version of plan.imported) {
      assert.equal(version.profile.status, 'Published', version.name);
    }
  });

  test('Pub Date comes from the source and is marked approximate', () => {
    for (const version of plan.imported) {
      if (version.profile.pubDate !== undefined) {
        assert.equal(
          version.pubDateIsApproximate,
          true,
          `${version.name} presents a publication date as exact`,
        );
      }
    }
    // Every record has `created`, so every imported version has a date.
    assert.equal(plan.imported.every((v) => v.profile.pubDate !== undefined), true);
  });

  test('Version, Pub Date and Status are no longer shortfalls', () => {
    for (const field of ['Version', 'Pub Date', 'Status']) {
      assert.equal(plan.shortfalls[field] ?? 0, 0, `${field} should be resolved by policy`);
    }
  });
});

describe('what the import will actually publish', () => {
  test('39 conforming VERSIONS across 38 conforming NAMES — and the two are different', () => {
    // §19.2 measured 38 records able to fill the mappable Header fields. The
    // policy produces 39 conforming versions, because `padi.game.presence` has
    // a complete Header and two versions and so contributes two. Both numbers
    // are true; reporting versions as names would overstate the namespace.
    assert.equal(plan.conforming + plan.nonConforming, plan.imported.length);
    assert.equal(plan.conforming, 39);
    assert.equal(plan.conformingNames, 38);

    const multi = plan.imported.filter((v) => v.profile.name === 'padi.game.presence');
    assert.equal(multi.length, 2);
    assert.ok(multi.every((v) => v.conforms), 'both versions of the complete record conform');
  });

  test('every non-conforming version names exactly which fields it lacks', () => {
    for (const version of plan.imported) {
      if (!version.conforms) {
        assert.ok(
          version.missingHeaderFields.length > 0,
          `${version.name} is non-conforming but names no missing field`,
        );
      } else {
        assert.deepEqual(version.missingHeaderFields, [], version.name);
      }
    }
  });

  test('the shortfalls are the six mappable fields and nothing else', () => {
    const fields = Object.keys(plan.shortfalls).sort();
    assert.deepEqual(fields, ['Consumer', 'Description', 'Owner', 'Provider', 'Title', 'Website']);
  });

  test('everything imported is marked grandfathered (spec §7.1)', () => {
    for (const version of plan.imported) assert.equal(version.grandfathered, true);
  });

  test('every imported version serializes to the 2026 shape', () => {
    for (const version of plan.imported) {
      const out = serializeProfileVersion(version.profile, 0) as {
        Header: Record<string, unknown>;
        Properties: unknown;
      };
      assert.equal(out.Header['Name'], version.profile.name);
      assert.equal(out.Header['Status'], 'Published');
      assert.equal(out.Header['Version'], String(version.version));
      assert.ok(out.Properties);
    }
  });

  test('no imported name is under a reserved Prefix, and none is single-segment', () => {
    for (const version of plan.imported) {
      assert.ok(version.profile.name.includes('.'), version.profile.name);
      assert.ok(!version.profile.name.startsWith('test.'), version.profile.name);
      assert.ok(!version.profile.name.startsWith('example.'), version.profile.name);
    }
  });
});
