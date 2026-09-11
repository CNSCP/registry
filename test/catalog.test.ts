/**
 * The browse surfaces — the root index (GET /) and the catalog (GET /profiles).
 *
 * Both are selection surfaces in the §18 sense: revalidated, never immutable.
 * Both carry the two disciplines of the read path with them:
 *
 *   §4.1 rule 1 — the index shows stable public facts about allocations only
 *   (holder, grandfathered, counts); never status, class, pending_claimant, or
 *   anything in flight.
 *
 *   §7.7 — the catalog is a TEXT SEARCH OVER STRINGS and says so. Its prefix
 *   filter tests the segment boundary and implies no hierarchy.
 *
 * Runs against the real imported corpus, so the assertions are about actual
 * records — the same search a person would run to find the HVAC profiles.
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
import { registerResolutionRoutes } from '../src/part-three/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(
  JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')),
);

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;

/** The import registers 69 names; the catalog's totals are asserted against it. */
const IMPORTED_NAMES = 69;

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

describe('the root index', () => {
  test('lists every allocated Prefix with stable public facts', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-cache');

    const { allocations } = response.json() as {
      allocations: {
        tlp: string; holder: string | null; grandfathered: boolean;
        names: number; published_versions: number; published_names: number; unpublished_names: number;
      }[];
    };

    const padi = allocations.find((a) => a.tlp === 'padi');
    assert.ok(padi, 'the padi allocation is listed');
    assert.equal(padi.holder, 'Padi, Inc.');
    assert.equal(padi.grandfathered, true);
    assert.ok(padi.names >= 20, `padi holds the bulk of the corpus (saw ${padi.names})`);
    assert.ok(padi.published_versions >= padi.names - 3, 'nearly every padi name has a published version');
    // The published/unpublished split counts NAMES, and adds up. In the
    // imported corpus exactly padi.appliance and padi.device are registered
    // with nothing published (§12.1).
    assert.equal(padi.published_names + padi.unpublished_names, padi.names);
    assert.equal(padi.unpublished_names, 2);

    // A withheld Prefix has a real allocation row (§3.2) and appears; the
    // spec-reserved `test` has no row, ever, and does not.
    assert.ok(allocations.some((a) => a.tlp === 'proto'), 'withheld proto is a real allocation');
    assert.ok(!allocations.some((a) => a.tlp === 'test'), 'spec-reserved test is never allocated');

    // The names beneath every allocation sum to the imported corpus plus
    // whatever infrastructure Prefixes hold (none).
    const names = allocations.reduce((sum, a) => sum + a.names, 0);
    assert.equal(names, IMPORTED_NAMES);
  });

  test('never exposes governance state', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    const raw = response.body;
    // §4.1 rule 1, asserted on the wire: no allocation status vocabulary, no
    // pending claimants, no class, anywhere in the body.
    for (const leaked of ['pending_claimant', '"status"', '"class"', 'locked', 'redemption', 'closed_to_registration']) {
      assert.ok(!raw.includes(leaked), `the index must not carry ${leaked}`);
    }
  });

  test('renders HTML for a browser', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.match(response.body, /cp:padi/);
    assert.match(response.body, /href="\/padi"/);
  });
});

describe('the unversioned Profile page (HTML courtesy)', () => {
  test('a browser sees the newest published version, with the others one click away', async () => {
    // padi.game.presence has two published versions; the browser lands on v2.
    const response = await app.inject({
      method: 'GET', url: '/padi.game.presence', headers: { accept: 'text/html' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-cache', 'still the selection surface');
    assert.match(response.body, /cp:padi\.game\.presence:2/);
    assert.match(response.body, /href="\/padi\.game\.presence:1"/, 'the version strip links v1');

    // The machine shape is untouched: still the version list, not a document.
    const machine = await app.inject({ method: 'GET', url: '/padi.game.presence' });
    const json = machine.json() as { versions: unknown[]; Header?: unknown };
    assert.equal(json.Header, undefined);
    assert.equal(json.versions.length, 2);
  });

  test('a name with nothing published keeps its registered-only page', async () => {
    const response = await app.inject({
      method: 'GET', url: '/padi.appliance', headers: { accept: 'text/html' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /No published versions/);
    assert.match(response.body, /lives with its author/);
  });
});

describe('the catalog', () => {
  test('lists the namespace, paged, with a stable total', async () => {
    const response = await app.inject({ method: 'GET', url: '/profiles' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-cache');

    const body = response.json() as { total: number; count: number; entries: { name: string }[]; next?: string; note: string };
    assert.equal(body.total, IMPORTED_NAMES);
    assert.equal(body.count, 50, 'the default page is 50');
    assert.equal(body.next, '/profiles?offset=50');
    assert.match(body.note, /spec §7.7/);
    assert.match(body.note, /not an index/);
  });

  test('the last page is partial and final', async () => {
    const response = await app.inject({ method: 'GET', url: '/profiles?offset=50' });
    const body = response.json() as { total: number; count: number; next?: string; prev?: string };
    assert.equal(body.total, IMPORTED_NAMES);
    assert.equal(body.count, IMPORTED_NAMES - 50);
    assert.equal(body.next, undefined);
    assert.equal(body.prev, '/profiles');
  });

  test('?q= searches names AND published Header text', async () => {
    // The search a person actually ran: find the HVAC profiles. One matches by
    // name, one only by its Description ("...a piece of HVAC equipment").
    const response = await app.inject({ method: 'GET', url: '/profiles?q=hvac' });
    const body = response.json() as { entries: { name: string }[] };
    const names = body.entries.map((e) => e.name);
    assert.ok(names.includes('padi.test.hvac.rtu'), 'matches by name');
    assert.ok(names.includes('padi.tstat.basic'), 'matches by Description, not name');
  });

  test('?q= is a literal text search — LIKE wildcards are not special', async () => {
    const wildcard = await app.inject({ method: 'GET', url: `/profiles?q=${encodeURIComponent('%')}` });
    assert.equal(wildcard.statusCode, 200);
    assert.equal((wildcard.json() as { total: number }).total, 0, 'a bare % matches nothing, not everything');

    const underscore = await app.inject({ method: 'GET', url: `/profiles?q=${encodeURIComponent('_____')}` });
    assert.equal((underscore.json() as { total: number }).total, 0);
  });

  test('?prefix= filters at the segment boundary (§7.7: strings, not a tree)', async () => {
    const onuma = await app.inject({ method: 'GET', url: '/profiles?prefix=onuma' });
    const onumaBody = onuma.json() as { total: number; entries: { name: string }[] };
    assert.equal(onumaBody.total, 6);
    assert.ok(onumaBody.entries.every((e) => e.name.startsWith('onuma.')));

    // `padi.test` the string matches `padi.test` and `padi.test.*` — and never
    // `padi.tstat.basic`, which merely shares characters.
    const dotted = await app.inject({ method: 'GET', url: '/profiles?prefix=padi.test' });
    const dottedBody = dotted.json() as { entries: { name: string }[] };
    const dottedNames = dottedBody.entries.map((e) => e.name);
    assert.ok(dottedNames.includes('padi.test'));
    assert.ok(dottedNames.includes('padi.test.abc'));
    assert.ok(!dottedNames.includes('padi.tstat.basic'), 'the segment boundary holds');

    // A prefix that is a proper substring of real segments matches nothing.
    const truncated = await app.inject({ method: 'GET', url: '/profiles?prefix=pad' });
    assert.equal((truncated.json() as { total: number }).total, 0);
  });

  test('names with nothing published appear — registration is a public fact (§7.3)', async () => {
    const response = await app.inject({ method: 'GET', url: '/profiles?prefix=padi.appliance' });
    const body = response.json() as { entries: { name: string; versions: unknown[] }[] };
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]!.versions.length, 0);
  });

  test('malformed parameters are refused, not coerced', async () => {
    for (const url of [
      '/profiles?limit=0',
      '/profiles?limit=5000',
      '/profiles?limit=ten',
      '/profiles?offset=-1',
      '/profiles?offset=1.5',
      '/profiles?prefix=Padi',
      '/profiles?prefix=padi..x',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400, url);
    }
  });

  test('paging links carry the search along', async () => {
    const response = await app.inject({ method: 'GET', url: '/profiles?q=padi&limit=10&offset=10' });
    const body = response.json() as { next?: string; prev?: string };
    assert.equal(body.prev, '/profiles?q=padi&limit=10');
    assert.match(body.next ?? '', /^\/profiles\?q=padi&limit=10&offset=20$/);
  });

  test('renders HTML with the search framed as a search over strings', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/profiles?q=thermostat',
      headers: { accept: 'text/html' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /padi\.tstat\.basic/);
    assert.match(response.body, /text search over registered names/);
    assert.match(response.body, /spec §7.7/);
  });
});
