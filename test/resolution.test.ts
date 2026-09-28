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
import { registerResolutionRoutes, splitReference, renderVersionForTest } from '../src/part-three/routes.ts';
import { negotiate, contentDigest, etagMatches, legacyRetirementFromEnv } from '../src/part-three/http.ts';
import { createHash } from 'node:crypto';

/** What the body in this message hashes to, in the RFC 9530 form. */
function digestOf(body: string): string {
  return `sha-256=:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')}:`;
}

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
    assert.deepEqual(splitReference('acme.meter.flow:unpublished'), { name: 'acme.meter.flow', version: 'unpublished' });
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

  test('Content-Digest covers the bytes in the message, in every representation (§18)', async () => {
    // The check nothing made until 28 Sept, and the one that would have caught
    // a digest carrying the CANONICAL hash while the wire carried the author's
    // own key order. RFC 9530 defines this header as a digest of the content of
    // this message: a party that hashes what arrived and compares must find it
    // equal, or it concludes the answer was damaged in transit.
    for (const accept of ['application/cp+json; profile=2026', 'application/json']) {
      const r = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1', headers: { accept } });
      assert.equal(r.statusCode, 200, accept);
      assert.equal(r.headers['content-digest'], digestOf(r.body), accept);
    }
  });

  test('a grandfathered version digests to its own bytes too', async () => {
    // Authoring key order is furthest from canonical on the imported corpus,
    // so this is where a canonical-hash digest diverges most.
    const r = await app.inject({
      method: 'GET', url: '/padi.light:1',
      headers: { accept: 'application/cp+json; profile=2026' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['x-cp-grandfathered'], 'true');
    assert.equal(r.headers['content-digest'], digestOf(r.body));
    // ...and the ETag still carries the canonical content hash, unchanged.
    assert.match(String(r.headers['etag']), /^"[0-9a-f]{64}-spec2026"$/);
  });

  test('a 304 carries the validators and no digest — there is no body to digest', async () => {
    const first = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1' });
    const second = await app.inject({
      method: 'GET', url: '/padi.tstat.basic:1',
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    assert.equal(second.statusCode, 304);
    assert.equal(second.headers['etag'], first.headers['etag']);
    assert.equal(second.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(second.headers['content-digest'], undefined);
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

  test('the versioned HTML rendering revalidates; only the machine shapes are immutable', async () => {
    // The contract never changes; the page around it does. An immutable HTML
    // cache pins early visitors to the first design for a year.
    const html = await app.inject({
      method: 'GET', url: '/padi.tstat.basic:1', headers: { accept: 'text/html' },
    });
    assert.equal(html.headers['cache-control'], 'no-cache');
    assert.equal(html.headers['x-cp-status'], 'published');

    const machine = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1' });
    assert.match(String(machine.headers['cache-control']), /immutable/);
  });

  test('the page links the Website and names each role\'s party in its heading', async () => {
    const html = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1', headers: { accept: 'text/html' } });
    assert.equal(html.statusCode, 200);
    // Website is a pointer (spec §6.6 NOTE): followable, http(s) only, and
    // still shown as its text.
    assert.match(html.body, /<a href="https:\/\/padi\.io" target="_blank" rel="noopener noreferrer nofollow">https:\/\/padi\.io<\/a>/);
    // "Provider (Equipment)" / "Consumer (Thermostat)": the role, and the
    // party the Header names for it, so the table reads as who supplies what.
    assert.match(html.body, /<h3>Provider \(Equipment\)<\/h3>/);
    assert.match(html.body, /<h3>Consumer \(Thermostat\)<\/h3>/);
    // Both role tables share one column set and one set of widths, so they
    // line up; and every Name is in bold.
    const colgroups = [...html.body.matchAll(/<table class="attrs"><colgroup>(.*?)<\/colgroup>/g)].map((m) => m[1]);
    assert.equal(colgroups.length, 2);
    assert.equal(colgroups[0], colgroups[1]);
    assert.match(html.body, /<td><strong>[^<]+<\/strong><\/td>/);
  });

  test('a Channel-free version shows no Channels section; the section exists for versions that declare them', async () => {
    const plain = await app.inject({ method: 'GET', url: '/padi.tstat.basic:1', headers: { accept: 'text/html' } });
    assert.doesNotMatch(plain.body, /<h2>Channels<\/h2>/);
    // The rendering itself, on a Channel-bearing document (spec §6.8's camera):
    // every attribute of every Channel, as for Properties.
    const camera = {
      name: 'example.camera', version: 1, status: 'published' as const, published_at: new Date(),
      content: {
        Header: { Name: 'example.camera', Provider: 'Camera', Consumer: 'Viewer' },
        Properties: { Provider: [{ Name: 'state', Mandatory: 'yes', Propagate: 'yes', Description: 's' }], Consumer: [] },
        Channels: [
          { Name: 'control', Mode: 'stream', Protocol: 'rtsp', 'Provider Role': 'server', 'Consumer Role': 'client', Description: 'c' },
          { Name: 'media', Mode: 'datagram', Protocol: 'rtp', 'Provider Role': 'sender', 'Consumer Role': 'receiver', Description: 'm' },
        ],
      },
      served_bytes: null, content_hash: 'x', header_owner: null, header_website: null,
      grandfathered: false, pub_date_approximate: false, missing_header_fields: [],
    };
    const html = renderVersionForTest(camera);
    assert.match(html, /<h2>Channels<\/h2>/);
    assert.match(html, /<th>Provider Role<\/th>/);
    assert.match(html, /<td>rtsp<\/td>/);
    assert.match(html, /<td>datagram<\/td>/);
    assert.match(html, /<h3>Provider \(Camera\)<\/h3>/);
  });

  test('the selection ETag is representation-specific too — HTML and JSON are different bodies', async () => {
    // The regression this guards: a browser holding the HTML page revalidates,
    // the version list is unchanged, and a shared validator would 304 it onto
    // a stale rendering forever.
    const html = await app.inject({ method: 'GET', url: '/padi.tstat.basic', headers: { accept: 'text/html' } });
    const json = await app.inject({ method: 'GET', url: '/padi.tstat.basic' });
    assert.ok(html.headers['etag']);
    assert.notEqual(html.headers['etag'], json.headers['etag']);
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

describe('unpublished content — never held, never served (8 Sept §7.3, §9.3)', () => {
  test(':unpublished is never resolved, for any name, registered or not', async () => {
    for (const url of ['/padi.tstat.basic:unpublished', '/no.such.name:unpublished']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.json().resolvable, false, url);
      assert.match(response.json().note, /lives with its author/, url);
    }
  });

  test('the answer is uncacheable — it is a statement about the Registry, not the content', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:unpublished' });
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test('the old :draft token is a 400 with the rename named', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.tstat.basic:draft' });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /unpublished/);
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

describe('the 2022 alias, and its retirement (§19.2)', () => {
  const LEGACY = 'application/json';

  /**
   * Append a published version straight to the table. Published versions are
   * immutable by trigger, so a test that needs a Channel-bearing one in a
   * particular position has to add it rather than edit one.
   */
  async function addVersion(
    name: string,
    version: number,
    channels: Record<string, boolean>,
    options: { create?: boolean } = {},
  ): Promise<void> {
    if (options.create) {
      await db.query(
        `INSERT INTO profile (name, allocation_id, registered_at)
         SELECT $1, a.id, now() FROM allocation a WHERE a.tlp = split_part($1, '.', 1)`,
        [name],
      );
    }
    const document: Record<string, unknown> = {
      Header: { Name: name, Version: String(version), Status: 'Published', Title: 't', Provider: 'P', Consumer: 'C' },
      Properties: { Provider: [{ Name: 'state', Mandatory: 'yes', Propagate: 'yes', Description: 'd' }], Consumer: [] },
    };
    if (Object.keys(channels).length > 0) {
      document['Channels'] = Object.keys(channels).map((n) => ({
        Name: n, Mode: 'stream', Protocol: 'mqtt', Description: 'e',
      }));
    }
    await db.query(
      `INSERT INTO profile_version (profile_id, version, content, content_hash, status, published_at)
       SELECT p.id, $2, $3::jsonb, $4, 'published', now() FROM profile p WHERE p.name = $1`,
      [name, version, JSON.stringify(document), `test-${name}-${version}`],
    );
  }

  test('a bare name on the alias returns the WHOLE 2022 document, not the selection surface', async () => {
    // Arete's finding, 23 Sept: this used to answer {name, registered,
    // versions:[{version,status,…}]}, which is a different object from what the
    // server this alias replaces returns — not a differently-shaped one.
    const r = await app.inject({ method: 'GET', url: '/profiles/padi.light', headers: { accept: LEGACY } });
    assert.equal(r.statusCode, 200);
    const doc = r.json() as Record<string, unknown>;

    assert.equal(doc['name'], 'padi.light');
    assert.equal(typeof doc['title'], 'string');
    assert.equal(typeof doc['company'], 'string');
    assert.equal(typeof doc['server'], 'string');
    assert.equal(typeof doc['client'], 'string');
    assert.ok(Array.isArray(doc['versions']));
    assert.equal((doc['versions'] as unknown[]).length, 1);

    // It is the 2022 shape all the way down: presence-encoded flags, no 2026 keys.
    const first = (doc['versions'] as Record<string, unknown>[])[0]!;
    const properties = first['properties'] as Record<string, unknown>[];
    assert.ok(properties.length > 0);
    assert.ok('name' in properties[0]!);
    assert.equal(doc['Header'], undefined);
    assert.equal(first['version'], undefined, 'the 2022 shape carries no version identifier');
  });

  test('it matches what the corpus holds for that name — the golden', async () => {
    const expected = corpus.find((p) => p.name === 'padi.light')!;
    const r = await app.inject({ method: 'GET', url: '/profiles/padi.light', headers: { accept: LEGACY } });
    const doc = r.json() as { versions: { properties: unknown[] }[] };
    assert.deepEqual(
      doc.versions.map((v) => v.properties),
      expected.versions!.map((v) => v.properties.map((prop) => ({
        ...(prop.role === 'provider' ? { server: null } : {}),
        name: prop.name,
        ...(prop.propagate ? { propagate: null } : {}),
        description: prop.description,
        ...(prop.mandatory ? { required: null } : {}),
      }))),
    );
  });

  test('every version is carried, in order — the index IS the version number', async () => {
    const r = await app.inject({ method: 'GET', url: '/profiles/padi.game.presence', headers: { accept: LEGACY } });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { versions: unknown[] }).versions.length, 2);
  });

  test('a version the 2022 shape cannot carry TRUNCATES the array — it is never dropped from the middle', async () => {
    // Dropping one would renumber every version after it, serving version 3's
    // Properties under the number 2: a changed contract, which is the thing the
    // versioned alias answers 406 rather than do.
    // A published version cannot be mutated — the database refuses it (§6.4,
    // §9.3) — so history is EXTENDED: 3 declares Channels, 4 does not. A reader
    // must see 1 and 2 and stop, never 1, 2 and 4 renumbered as three.
    await addVersion('padi.game.presence', 3, { events: true });
    await addVersion('padi.game.presence', 4, {});

    const r = await app.inject({ method: 'GET', url: '/profiles/padi.game.presence', headers: { accept: LEGACY } });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { versions: unknown[] }).versions.length, 2, 'stops at the version it cannot carry');

    // ...and the versioned form still refuses the Channel-bearing one outright.
    const versioned = await app.inject({ method: 'GET', url: '/profiles/padi.game.presence:3', headers: { accept: LEGACY } });
    assert.equal(versioned.statusCode, 406);
    // The 2026 shape is unaffected by any of this: 4 is reachable and is itself.
    const spec = await app.inject({ method: 'GET', url: '/padi.game.presence:4', headers: { accept: SPEC } });
    assert.equal(spec.statusCode, 200);
  });

  test('when no version can be carried at all, the document is refused rather than served empty', async () => {
    // Every version of this one declares Channels, so there is no prefix of
    // history the 2022 shape can carry at all.
    await addVersion('acme.only-channels', 1, { events: true }, { create: true });

    const r = await app.inject({ method: 'GET', url: '/profiles/acme.only-channels', headers: { accept: LEGACY } });
    assert.equal(r.statusCode, 406);
    assert.match(String(r.json().error), /2022/);
  });

  test('a name registered with nothing published answers name-and-no-versions, not 406', async () => {
    // What the 0.11.0 server gives is metadata and no `versions` key. We give
    // the same shape minus the metadata, because a Header arrives with a
    // published version and the Registry holds none before that (spec §7.3).
    // Confirmed against the old server on 28 Sept for padi.device.
    await db.query(
      `INSERT INTO profile (name, allocation_id, registered_at)
       SELECT 'padi.nothing-yet', a.id, now() FROM allocation a WHERE a.tlp = 'padi'`,
    );
    const r = await app.inject({ method: 'GET', url: '/profiles/padi.nothing-yet', headers: { accept: LEGACY } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { name: 'padi.nothing-yet' });
    assert.equal('versions' in (r.json() as object), false, 'no versions key at all, as the old server does');
  });

  test('a host told nothing about the retirement says nothing', async () => {
    const r = await app.inject({ method: 'GET', url: '/profiles/padi.light', headers: { accept: LEGACY } });
    assert.equal(r.headers['deprecation'], undefined);
    assert.equal(r.headers['sunset'], undefined);
  });

  test('a host told the dates marks every 2022 answer, and no other', async () => {
    const marked = Fastify();
    await registerResolutionRoutes(marked, {
      db,
      legacy: legacyRetirementFromEnv({
        LEGACY_DEPRECATION: '@1767225599',
        LEGACY_SUNSET: 'Wed, 31 Dec 2025 23:59:59 GMT',
        LEGACY_MIGRATION_URL: 'https://cnscp.io/legacy',
      } as NodeJS.ProcessEnv),
    });
    await marked.ready();
    try {
      for (const url of ['/profiles/padi.light', '/profiles/padi.light:1']) {
        const r = await marked.inject({ method: 'GET', url, headers: { accept: LEGACY } });
        assert.equal(r.statusCode, 200, url);
        assert.equal(r.headers['deprecation'], '@1767225599', url);
        assert.equal(r.headers['sunset'], new Date('Wed, 31 Dec 2025 23:59:59 GMT').toUTCString(), url);
        assert.match(String(r.headers['link']), /rel="deprecation"/, url);
      }
      // The 2026 shape is not deprecated and must not say it is.
      const spec = await marked.inject({ method: 'GET', url: '/padi.light:1', headers: { accept: SPEC } });
      assert.equal(spec.headers['deprecation'], undefined);
      assert.equal(spec.headers['sunset'], undefined);
    } finally {
      await marked.close();
    }
  });

  test('Sunset is refused if it precedes Deprecation (RFC 9745)', () => {
    assert.throws(
      () => legacyRetirementFromEnv({
        LEGACY_DEPRECATION: '@1767225599',
        LEGACY_SUNSET: 'Thu, 01 Jan 2015 00:00:00 GMT',
      } as NodeJS.ProcessEnv),
      /not be earlier/,
    );
  });
});

describe('cross-origin reads (§19.4)', () => {
  const ORIGIN = { origin: 'https://example.test' };
  const EXPOSED = ['etag', 'content-digest', 'x-cp-status', 'deprecation', 'sunset', 'link'];

  function assertOpen(r: { headers: Record<string, unknown> }, where: string): void {
    assert.equal(r.headers['access-control-allow-origin'], '*', where);
    const exposed = String(r.headers['access-control-expose-headers']).toLowerCase();
    for (const h of EXPOSED) assert.ok(exposed.includes(h), `${where}: ${h} not exposed`);
    assert.equal(r.headers['access-control-allow-credentials'], undefined, where);
    assert.doesNotMatch(String(r.headers['vary'] ?? ''), /origin/i, `${where}: must not vary on Origin`);
  }

  test('every public read surface answers a cross-origin GET', async () => {
    for (const url of [
      '/', '/health', '/profiles', '/padi.light', '/padi.light:1', '/padi.light/registration',
      '/profiles/padi.light', '/padi', '/policy/prefixes', '/distribution/snapshot',
      '/distribution/status', '/.well-known/cp-anchor',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: ORIGIN });
      assertOpen(r, url);
    }
  });

  test('the responses a browser actually meets carry them too, not just the happy path', async () => {
    // An error a browser cannot read is an error it cannot report.
    const head = await app.inject({ method: 'HEAD', url: '/padi.light:1', headers: ORIGIN });
    assertOpen(head, 'HEAD');

    const first = await app.inject({ method: 'GET', url: '/padi.light:1', headers: ORIGIN });
    const revalidated = await app.inject({
      method: 'GET', url: '/padi.light:1',
      headers: { ...ORIGIN, 'if-none-match': String(first.headers['etag']) },
    });
    assert.equal(revalidated.statusCode, 304);
    assertOpen(revalidated, '304');

    const missing = await app.inject({ method: 'GET', url: '/no.such.name', headers: ORIGIN });
    assert.equal(missing.statusCode, 404);
    assertOpen(missing, '404');

    const refused = await app.inject({
      method: 'GET', url: '/profiles/padi.game.presence:3',
      headers: { ...ORIGIN, accept: 'application/json' },
    });
    assert.equal(refused.statusCode, 406);
    assertOpen(refused, '406');

    const malformed = await app.inject({ method: 'GET', url: '/padi.light:banana', headers: ORIGIN });
    assert.equal(malformed.statusCode, 400);
    assertOpen(malformed, '400');
  });

  test('a real preflight is answered — the shape a browser sends', async () => {
    // Not a bare OPTIONS: a preflight carries these two fields, and the one
    // that matters is If-None-Match, which is NOT CORS-safelisted. Without an
    // answer here a browser client works until it starts revalidating.
    const r = await app.inject({
      method: 'OPTIONS', url: '/padi.light:1',
      headers: {
        ...ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'if-none-match',
      },
    });
    assert.equal(r.statusCode, 204);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.match(String(r.headers['access-control-allow-methods']), /GET/);
    assert.match(String(r.headers['access-control-allow-headers']).toLowerCase(), /if-none-match/);
    assert.ok(Number(r.headers['access-control-max-age']) > 0);
  });

  test('the identity surface is not public, and neither is a write', async () => {
    for (const url of ['/account', '/auth/google', '/auth']) {
      const r = await app.inject({ method: 'GET', url, headers: ORIGIN });
      assert.equal(r.headers['access-control-allow-origin'], undefined, url);
    }
    // Preflighting one is refused rather than answered.
    const pre = await app.inject({
      method: 'OPTIONS', url: '/account',
      headers: { ...ORIGIN, 'access-control-request-method': 'GET' },
    });
    assert.equal(pre.statusCode, 404);

    // A write carries nothing, whatever the path.
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/padi.light:1', headers: ORIGIN });
      assert.equal(r.headers['access-control-allow-origin'], undefined, method);
    }
  });

  test('the exposed list names only headers the server actually sends', async () => {
    // A list that drifts is how this goes stale. Every name in it must appear
    // on some real answer.
    const seen = new Set<string>();
    for (const [url, accept] of [
      ['/padi.light:1', SPEC],
      ['/profiles/padi.light', 'application/json'],
      ['/padi.light', SPEC],
    ] as const) {
      const r = await app.inject({ method: 'GET', url, headers: { accept } });
      for (const k of Object.keys(r.headers)) seen.add(k.toLowerCase());
    }
    // x-cp-surface and x-cp-grandfathered are instance/import specific; the
    // rest must be present somewhere on canon's own answers.
    for (const h of ['etag', 'content-digest', 'x-cp-status']) {
      assert.ok(seen.has(h), `${h} is exposed but never sent`);
    }
  });
});

describe('http helpers', () => {
  test('Content-Digest is RFC 9530 base64 of the hash of the bytes given', () => {
    const digest = contentDigest('{"Header":{}}');
    assert.match(digest, /^sha-256=:[A-Za-z0-9+/=]+:$/);
    assert.equal(digest, digestOf('{"Header":{}}'));
    // A string and its bytes are one message.
    assert.equal(contentDigest(Buffer.from('{"Header":{}}', 'utf8')), digest);
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
