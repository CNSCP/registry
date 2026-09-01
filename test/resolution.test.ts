/**
 * Part Three resolution — design §17, §18, §19; spec §7.4 and §9.3.
 *
 * Runs against a real database holding the real imported corpus, because the
 * questions worth asking are about actual records: does `padi.tstat.basic`
 * resolve, does a version-less name answer correctly, does a grandfathered
 * record publish its shortfalls.
 *
 * THE MOST IMPORTANT BLOCK IN THIS FILE is "§4.1 rule 1". Governance state must
 * never reach the read path — a suspended organization, a locked allocation, a
 * dispute in flight must all resolve exactly as before, because spec §9.3
 * answers "to any party" regardless of what has become of an author. Right now
 * a comment in `part-three/store.ts` is what prevents the naive join; these
 * tests are what would catch its removal.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { parseCorpus } from '../src/profile/legacy.ts';
import { planImport } from '../src/profile/import.ts';
import { runImport } from '../src/seed/import-profiles.ts';
import { registerResolutionRoutes, splitReference } from '../src/part-three/routes.ts';
import { negotiate, contentDigest, etagMatches } from '../src/part-three/http.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(
  JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')),
);

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await applySeed(client);
    await runImport(client, corpus, planImport(corpus));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  app = Fastify();
  await registerResolutionRoutes(app, { db });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

const SPEC = 'application/cp+json; profile=2026';

describe('the dot rule (§19)', () => {
  test('a dotted first segment is a Profile; a dotless one is an allocation', async () => {
    const profile = await app.inject({ method: 'GET', url: '/padi.tstat.basic' });
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().name, 'padi.tstat.basic');

    const allocation = await app.inject({ method: 'GET', url: '/padi' });
    assert.equal(allocation.statusCode, 200);
    assert.equal(allocation.json().reference, 'cp:padi');
  });

  test('reserved dotless paths are not shadowed', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().part, 'three');

    const profiles = await app.inject({ method: 'GET', url: '/profiles' });
    assert.equal(profiles.statusCode, 200);
  });

  test('the version separator is a colon within one path segment', () => {
    assert.deepEqual(splitReference('acme.meter.flow'), { name: 'acme.meter.flow', version: null });
    assert.deepEqual(splitReference('acme.meter.flow:2'), { name: 'acme.meter.flow', version: 2 });
    assert.deepEqual(splitReference('acme.meter.flow:draft'), { name: 'acme.meter.flow', version: 'draft' });
  });

  test('sub-resources use a slash', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic/registration' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().registered, true);
  });

  test('a one-segment reference is refused as a Profile, not 404ed', async () => {
    // It denotes an allocation (spec §7.2). `proto` has an allocation, so it
    // renders that; a name that is neither is a 404 allocation lookup.
    const response = await app.inject({ method: 'GET', url: '/nosuchprefix' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().allocated, false);
  });
});

describe('§4.1 RULE 1 — governance state never reaches the read path', () => {
  // Everything here resolves fine BEFORE the governance change; the assertion
  // is that it resolves identically AFTER. Spec §9.3: a conforming Registry
  // "serves the namespace without regard to the identity of the party
  // presenting a name" and answers published versions to any party.

  async function resolves(name: string): Promise<number> {
    const response = await app.inject({ method: 'GET', url: `/${name}:1` });
    return response.statusCode;
  }

  test('a SUSPENDED holder organization does not affect resolution', async () => {
    assert.equal(await resolves('padi.tstat.basic'), 200);

    await db.query(`UPDATE organization SET status = 'suspended' WHERE is_operator`);
    assert.equal(await resolves('padi.tstat.basic'), 200, 'suspension broke resolution');

    await db.query(`UPDATE organization SET status = 'active' WHERE is_operator`);
  });

  test('a LOCKED allocation does not affect resolution', async () => {
    await db.query(`UPDATE allocation SET status = 'locked' WHERE tlp = 'padi'`);
    assert.equal(await resolves('padi.tstat.basic'), 200, 'a dispute hold broke resolution');
    await db.query(`UPDATE allocation SET status = 'active' WHERE tlp = 'padi'`);
  });

  test('an allocation in REDEMPTION does not affect resolution', async () => {
    await db.query(`UPDATE allocation SET status = 'redemption' WHERE tlp = 'padi'`);
    assert.equal(await resolves('padi.tstat.basic'), 200, 'a lapsed term broke resolution');
    await db.query(`UPDATE allocation SET status = 'active' WHERE tlp = 'padi'`);
  });

  test('a DISSOLVED holder does not affect resolution — the author is gone, the contract is not', async () => {
    await db.query(`UPDATE organization SET status = 'dissolved' WHERE is_operator`);
    assert.equal(await resolves('padi.tstat.basic'), 200);
    await db.query(`UPDATE organization SET status = 'active' WHERE is_operator`);
  });

  test('a closed-to-registration Prefix still resolves everything beneath it', async () => {
    // proto is closed (§10.2 ruling 2) and its 13 imported names must still work.
    const response = await app.inject({ method: 'GET', url: '/proto.weather.sensor:1' });
    assert.equal(response.statusCode, 200);
  });

  test('the resolution response body never contains governance state', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic' });
    const raw = response.body;
    for (const leak of ['suspended', 'locked', 'redemption', 'org_id', 'allocation_id', 'pending_claimant']) {
      assert.ok(!raw.includes(leak), `resolution leaked "${leak}"`);
    }
  });

  test('the allocation page carries no in-flight governance either (§19.3)', async () => {
    await db.query(`UPDATE allocation SET status = 'locked' WHERE tlp = 'onuma'`);
    const response = await app.inject({ method: 'GET', url: '/onuma' });
    assert.equal(response.statusCode, 200);
    const raw = response.body;
    // Holder is a stable public fact; a lock and a pending claimant are not.
    assert.ok(raw.includes('holder'));
    for (const leak of ['locked', 'pending_claimant', 'ONUMA"', 'redemption', 'dispute']) {
      assert.ok(!raw.includes(leak), `the allocation page leaked "${leak}"`);
    }
    await db.query(`UPDATE allocation SET status = 'active' WHERE tlp = 'onuma'`);
  });
});

describe('the caching split (§18)', () => {
  test('a VERSIONED fetch is immutable — the contract never changes', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(String(response.headers['etag']), /^"[0-9a-f]{64}-spec2026"$/);
    assert.ok(String(response.headers['content-digest']).startsWith('sha-256=:'));
  });

  test('an UNVERSIONED fetch is the selection surface and is always revalidated', async () => {
    // §17: this is what a Governor reads at Match. If it were immutable-cached,
    // a local instance would keep selecting a version deprecated a year ago.
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic' });
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.ok(response.headers['etag']);
  });

  test('the selection ETag changes when a version is deprecated', async () => {
    const before = await app.inject({ method: 'GET', url: '/padi.light' });
    const beforeEtag = before.headers['etag'];

    await db.query(
      `UPDATE profile_version SET status = 'deprecated'
        WHERE profile_id = (SELECT id FROM profile WHERE name = 'padi.light')`,
    );

    const after = await app.inject({ method: 'GET', url: '/padi.light' });
    assert.notEqual(after.headers['etag'], beforeEtag, 'deprecation must invalidate the selection surface');
    assert.equal(after.json().versions[0].status, 'deprecated');
  });

  test('a Governor revalidating the selection surface gets 304 when nothing moved', async () => {
    const first = await app.inject({ method: 'GET', url: '/padi.tstat.basic' });
    const second = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic',
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    assert.equal(second.statusCode, 304);
  });

  test('a versioned fetch honours If-None-Match too', async () => {
    const first = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1' });
    const second = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic:1',
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    assert.equal(second.statusCode, 304);
  });

  test('deprecation is surfaced additively — the Properties are untouched', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.light:1' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-cp-status'], 'deprecated');
    // The document itself still says what it said at publication.
    const document = JSON.parse(response.body);
    assert.ok(document.Properties, 'deprecation must not mutate the contract');
  });

  test('the ETag is representation-specific — one contract, two entities', async () => {
    const spec = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1' });
    const legacy = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic:1',
      headers: { accept: 'application/json' },
    });
    assert.notEqual(spec.headers['etag'], legacy.headers['etag']);
  });

  test('Vary: Accept on every resolution response', async () => {
    for (const url of ['/padi.tstat.basic', '/padi.tstat.basic:1', '/padi']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.headers['vary'], 'Accept', url);
    }
  });
});

describe('content negotiation (§19.2, §25 Q2 settled)', () => {
  test('Accept: */* resolves to the 2026 shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic:1',
      headers: { accept: '*/*' },
    });
    assert.match(String(response.headers['content-type']), /application\/cp\+json/);
    assert.ok(JSON.parse(response.body).Header, 'the 2026 shape has a Header object');
  });

  test('no Accept header at all resolves to the 2026 shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1' });
    assert.ok(JSON.parse(response.body).Header);
  });

  test('application/json gets the deployed shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic:1',
      headers: { accept: 'application/json' },
    });
    const body = JSON.parse(response.body);
    assert.ok(body.versions, 'the deployed shape has versions[]');
    assert.ok(!body.Header);
  });

  test('the /profiles/ alias defaults to the deployed shape for legacy SDKs', async () => {
    const response = await app.inject({ method: 'GET', url: '/profiles/padi.tstat.basic:1' });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.versions, 'ARETE.md documents this path; unmodified SDKs expect the old shape');
  });

  test('key-presence flags survive the round trip out through the legacy path', async () => {
    // The whole hazard, end to end: stored as the 2026 shape, served as the
    // deployed one, with `"server": null` meaning provider.
    const response = await app.inject({ method: 'GET', url: '/profiles/padi.tstat.basic:1' });
    const body = JSON.parse(response.body);
    const properties = body.versions[0].properties as Record<string, unknown>[];
    assert.ok(properties.length > 0);
    for (const property of properties) {
      if ('server' in property) assert.equal(property['server'], null, 'a set flag must be present-and-null');
    }
  });

  test('a browser gets HTML', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic:1',
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    assert.match(String(response.headers['content-type']), /text\/html/);
  });

  test('negotiate() prefers HTML only when it is actually asked for', () => {
    assert.equal(negotiate('*/*'), 'spec2026');
    assert.equal(negotiate(undefined), 'spec2026');
    assert.equal(negotiate(''), 'spec2026');
    assert.equal(negotiate('application/json'), 'legacy');
    assert.equal(negotiate('text/html'), 'html');
    assert.equal(negotiate('text/html;q=0.1,application/json;q=0.9'), 'legacy');
  });
});

describe('what a person gets (§19.1)', () => {
  test('the page shows every Property attribute and summarizes nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/padi.tstat.basic:1',
      headers: { accept: 'text/html' },
    });
    const html = response.body;
    for (const attribute of ['Name', 'Mandatory', 'Propagate', 'Description']) {
      assert.ok(html.includes(attribute), `the page dropped the ${attribute} column`);
    }
    assert.ok(html.includes('The contract is the document, not this page'));
    assert.ok(html.includes('Accept: application/cp+json'), 'the raw form must be cited');
  });

  test('an imported version publishes its §9.4 shortfalls on the page', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT p.name FROM profile p JOIN profile_version v ON v.profile_id = p.id
        WHERE cardinality(v.missing_header_fields) > 0 LIMIT 1`,
    );
    const response = await app.inject({
      method: 'GET',
      url: `/${rows[0]!.name}:1`,
      headers: { accept: 'text/html' },
    });
    assert.match(response.body, /does not carry every REQUIRED Header field/);
  });

  test('a name with no published versions says so rather than 404ing', async () => {
    // padi.appliance is registered and publishes nothing (§12.1).
    const response = await app.inject({ method: 'GET', url: '/padi.appliance' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().versions, []);
    assert.ok(response.json().registered);
  });
});

describe('what is NOT an index (§19.3)', () => {
  test('an unregistered interior name is a 404 in the machine representations', async () => {
    // padi.game.beacon exists; padi.game does not.
    const response = await app.inject({ method: 'GET', url: '/padi.game' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().registered, false);
    assert.match(response.json().note, /not an index/);
  });

  test('the HTML page may offer a string search, framed as one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/padi.game',
      headers: { accept: 'text/html' },
    });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /text search, not a hierarchy/);
    assert.match(response.body, /padi\.game\.beacon/);
  });
});

describe('Drafts (§13.3, spec §7.3)', () => {
  test('a private Draft is not answerable on the public read path', async () => {
    await db.query(
      `UPDATE profile SET draft_content = '{"x":1}'::jsonb, draft_disclosure = 'private'
        WHERE name = 'padi.tstat.basic'`,
    );
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:draft' });
    assert.equal(response.statusCode, 404);
    assert.match(response.json().note, /only as its owner authorizes/);
  });

  test('an `authorized` Draft is not answerable here either — this instance does not know who is asking', async () => {
    await db.query(`UPDATE profile SET draft_disclosure = 'authorized' WHERE name = 'padi.tstat.basic'`);
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:draft' });
    assert.equal(response.statusCode, 404);
  });

  test('a `public` Draft is answerable to any party — the trapdoor has been walked', async () => {
    await db.query(`UPDATE profile SET draft_disclosure = 'public' WHERE name = 'padi.tstat.basic'`);
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:draft' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { x: 1 });
  });

  test('a Draft is never cached — it may change at any time (spec §7.4)', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:draft' });
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

describe('the imported corpus resolves', () => {
  test('every imported name answers on the unversioned endpoint', async () => {
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM profile ORDER BY name`);
    assert.equal(rows.length, 69);

    let ok = 0;
    for (const row of rows) {
      const response = await app.inject({ method: 'GET', url: `/${row.name}` });
      assert.equal(response.statusCode, 200, `${row.name} did not resolve`);
      ok++;
    }
    assert.equal(ok, 69);
  });

  test('the renamed record resolves under its new name and not its old one', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/padi.test.abc' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/test.abc' })).statusCode, 404);
  });

  test('the excluded bare `proto` resolves as an ALLOCATION, never as a Profile', async () => {
    const response = await app.inject({ method: 'GET', url: '/proto' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reference, 'cp:proto');
    assert.ok(response.json().names.length > 0, 'its sub-names are listed beneath it');
  });

  test('the allocation page indexes every name beneath the Prefix (§19.3)', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi' });
    const body = response.json();
    assert.ok(body.names.length > 25, 'padi holds 27 records plus the renamed one');
    assert.ok(body.names.some((n: { name: string }) => n.name === 'padi.test.abc'));
    // Including the ones with nothing published — spec §7.3 makes the existence
    // of a registration public even where content is not.
    const appliance = body.names.find((n: { name: string }) => n.name === 'padi.appliance');
    assert.deepEqual(appliance.versions, []);
  });

  test('a served version replays the stored bytes verbatim (spec §9.3)', async () => {
    const { rows } = await db.query<{ served_bytes: Buffer }>(
      `SELECT v.served_bytes FROM profile_version v JOIN profile p ON p.id = v.profile_id
        WHERE p.name = 'padi.value' AND v.version = 1`,
    );
    const response = await app.inject({ method: 'GET', url: '/padi.value:1' });
    assert.equal(response.body, rows[0]!.served_bytes.toString('utf8'));
  });
});

describe('http helpers', () => {
  test('Content-Digest is RFC 9530 base64 of the raw hash', () => {
    const digest = contentDigest('ab'.repeat(32));
    assert.match(digest, /^sha-256=:[A-Za-z0-9+/=]+:$/);
  });

  test('If-None-Match handles lists, weak tags, and star', () => {
    assert.ok(etagMatches('"a"', '"a"'));
    assert.ok(etagMatches('"x", "a", "y"', '"a"'));
    assert.ok(etagMatches('W/"a"', '"a"'));
    assert.ok(etagMatches('*', '"anything"'));
    assert.ok(!etagMatches('"b"', '"a"'));
    assert.ok(!etagMatches(undefined, '"a"'));
  });
});
