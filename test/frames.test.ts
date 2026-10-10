/**
 * What frames the page — design §19.5, 9 October 2026.
 *
 * The document is the same on every host; the frame is not. The questions:
 *   - does canon keep its frame, and refuse to boot in any other?
 *   - does an instance stop dressing as canon — no cnscp.io site navigation,
 *     never "canonical", and a provenance line saying whose copy it is?
 *   - does a bare page carry nothing from another origin, but still say where
 *     it came from?
 *   - under a base path, does EVERY local link and form action carry it?
 *     (A sweep over every page kind, not a sample: one missed link is a click
 *     that leaves the embedding application.)
 *   - is every machine representation untouched by all of it?
 *
 * The byte-for-byte check that canon's pages did not move was run once,
 * against renders captured before the change; what stays here is what must
 * remain true from now on.
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { parseCorpus } from '../src/profile/legacy.ts';
import { planImport } from '../src/profile/import.ts';
import { runImport } from '../src/seed/import-profiles.ts';
import {
  SITE_NAV,
  framingFromEnv,
  registerResolutionRoutes,
  resetFraming,
  setFraming,
} from '../src/part-three/routes.ts';
import { registerInstanceRefusals } from '../src/distribution/routes.ts';
import { bootstrap, sync, type Fetch } from '../src/distribution/follower.ts';
import { createWorkspace } from '../src/workspace/routes.ts';
import { workspaceCredentialsFromEnv } from '../src/workspace/credential.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')));

const UPSTREAM = 'http://upstream.test';
const WS_TOKEN = 'workspace-'.padEnd(48, 'w');
const HTML = { accept: 'text/html' };

let authoritative: Harness;
let instance: Harness;
let upstreamApp: FastifyInstance;
let instanceApp: FastifyInstance;
let operatorName: string;
let seq: number;

function fetchVia(app: FastifyInstance): Fetch {
  return async (url) => {
    const path = url.startsWith(UPSTREAM) ? url.slice(UPSTREAM.length) : url;
    const response = await app.inject({ method: 'GET', url: path });
    return { status: response.statusCode, json: async () => response.json() };
  };
}

before(async () => {
  authoritative = await freshDatabase();
  instance = await freshDatabase({ workspace: true });

  const client = await authoritative.pool.connect();
  let orgId: string;
  try {
    await client.query('BEGIN');
    orgId = (await applySeed(client)).orgId;
    await runImport(client, corpus, planImport(corpus));
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  upstreamApp = Fastify();
  await registerResolutionRoutes(upstreamApp, { db: authoritative.pool });
  await upstreamApp.ready();

  await bootstrap(instance.pool, UPSTREAM, fetchVia(upstreamApp));
  seq = Number((await sync(instance.pool, fetchVia(upstreamApp))).cursor.seq);

  // The operator's name as THE MIRROR records it — what the instance's boot reads.
  const found = await instance.pool.query<{ name: string }>('SELECT name FROM organization WHERE id = $1', [orgId]);
  operatorName = found.rows[0]!.name;

  const workspace = createWorkspace({
    db: instance.pool,
    config: { orgs: [orgId], test: true },
    credentials: workspaceCredentialsFromEnv({ CP_WORKSPACE_TOKEN: WS_TOKEN, CP_WORKSPACE_PRINCIPAL: 'anto@padi.io' }),
    upstream: UPSTREAM,
  });
  instanceApp = Fastify();
  await registerResolutionRoutes(instanceApp, { db: instance.pool, role: 'instance', upstream: UPSTREAM, workspace: workspace.hooks });
  workspace.register(instanceApp);
  registerInstanceRefusals(instanceApp, UPSTREAM);
  await instanceApp.ready();

  // A test name is registered on this host before anything is saved under it (§20.3).
  const registered = await instanceApp.inject({ method: 'PUT', url: '/test.frames.demo', headers: { authorization: `Bearer ${WS_TOKEN}` } });
  assert.equal(registered.statusCode, 201, registered.body);

  const put = await instanceApp.inject({
    method: 'PUT',
    url: '/test.frames.demo:unpublished',
    headers: { authorization: `Bearer ${WS_TOKEN}`, 'content-type': 'application/json' },
    payload: {
      Header: {
        Name: 'test.frames.demo',
        Owner: 'Padi, Inc.',
        Title: 'A form, so the workspace pages have something to frame',
        Provider: 'Sensor',
        Consumer: 'Display',
        Description: 'Held on the instance.',
        Website: 'https://padi.io',
      },
      Properties: { Provider: [{ Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' }], Consumer: [] },
    },
  });
  assert.ok(put.statusCode < 300, `PUT ${put.statusCode} ${put.body}`);
});

afterEach(() => resetFraming());

after(async () => {
  resetFraming();
  await upstreamApp.close();
  await instanceApp.close();
  await authoritative.close();
  await instance.close();
});

const asInstance = (extra: Record<string, unknown> = {}) =>
  setFraming({ kind: 'instance', upstream: UPSTREAM, operator: operatorName, seq, basePath: '', ...extra });

/**
 * Every kind of page a host renders: index, catalog, search, allocation, name
 * (published, and registered with nothing published), version, the not-found
 * page, the workspace and a held form. (`:unpublished` on a name with no form,
 * a missing version and an unknown Prefix answer JSON whatever is asked — not
 * pages, so not framed.)
 */
const PAGES = [
  '/',
  '/profiles',
  '/profiles?q=light',
  '/profiles?prefix=padi&limit=3',
  '/padi',
  '/padi.light',
  '/padi.light:1',
  '/padi.lighting',
  '/padi.appliance',
  '/nosuch.name',
  '/workspace',
  '/test.frames.demo:unpublished',
];

async function html(app: FastifyInstance, url: string): Promise<string> {
  const r = await app.inject({ method: 'GET', url, headers: HTML });
  assert.match(String(r.headers['content-type']), /text\/html/, `${url} answered ${r.headers['content-type']}`);
  return r.body;
}

describe('choosing the frame (§19.5)', () => {
  test('canon and its replicas are the site, and refuse any other frame', () => {
    for (const entry of ['authoritative', 'resolution'] as const) {
      assert.deepEqual(framingFromEnv(entry, {}), { kind: 'site', basePath: '' });
      assert.deepEqual(framingFromEnv(entry, { PAGE_CHROME: 'site' }), { kind: 'site', basePath: '' });
      assert.throws(() => framingFromEnv(entry, { PAGE_CHROME: 'bare' }), /framed as the site, always/);
      assert.throws(() => framingFromEnv(entry, { PAGE_CHROME: 'instance' }), /framed as the site, always/);
      assert.throws(() => framingFromEnv(entry, { PUBLIC_BASE_PATH: '/registry' }), /serves from its own root/);
    }
  });

  test('an instance is "instance" by default, may be "bare", and is never the site', () => {
    assert.deepEqual(framingFromEnv('instance', {}), { kind: 'instance', basePath: '' });
    assert.deepEqual(framingFromEnv('instance', { PAGE_CHROME: 'bare', PUBLIC_BASE_PATH: '/registry/' }), {
      kind: 'bare',
      basePath: '/registry',
    });
    assert.throws(() => framingFromEnv('instance', { PAGE_CHROME: 'site' }), /never "site"/);
    assert.throws(() => framingFromEnv('instance', { PAGE_CHROME: 'fancy' }), /"instance" or "bare"/);
  });

  test('a base path is a plain path, with no dots — it must never look like a Profile name', () => {
    for (const bad of ['registry', '/reg.istry', '/a b', '/registry?x=1']) {
      assert.throws(() => framingFromEnv('instance', { PUBLIC_BASE_PATH: bad }), /PUBLIC_BASE_PATH/, bad);
    }
    assert.equal(framingFromEnv('instance', { PUBLIC_BASE_PATH: '/apps/cp-registry' }).basePath, '/apps/cp-registry');
  });
});

describe('the site frame (canon)', () => {
  test('carries the six, the footer, and calls itself canonical — and no provenance line', async () => {
    const page = await html(upstreamApp, '/');
    for (const item of SITE_NAV) assert.ok(page.includes(`href="${item.href}"`), `missing ${item.id}`);
    assert.match(page, /The canonical registry of/);
    assert.doesNotMatch(page, /class="provenance/);
  });
});

describe('the instance frame', () => {
  test('no page carries the cnscp.io site navigation, and none says "canonical"', async () => {
    asInstance();
    for (const url of PAGES) {
      const page = await html(instanceApp, url);
      for (const item of SITE_NAV.filter((i) => i.id !== 'home' && i.id !== 'registry')) {
        assert.ok(!page.includes(`href="${item.href}"`), `${url} still links ${item.id}`);
      }
      assert.doesNotMatch(page, /canonical/i, `${url} calls itself canonical`);
      // (The index's Prefix table links cp:account like any allocation; it is the NAV that must not offer one.)
      const header = page.slice(0, page.indexOf('</header>'));
      assert.doesNotMatch(header, /href="\/account"/, `${url} offers an Account an instance does not have`);
    }
  });

  test('every page names the operator and carries the provenance line with the verified seq', async () => {
    asInstance();
    for (const url of PAGES) {
      const page = await html(instanceApp, url);
      assert.ok(page.includes(`<span class="operator">${operatorName.replace(/&/g, '&amp;')}</span>`), `${url}: no operator`);
      assert.ok(page.includes('An instance of the CP Registry, operated by'), `${url}: no provenance`);
      assert.ok(page.includes(`verified to seq ${seq}</a>`), `${url}: no seq`);
      assert.ok(page.includes(`href="${UPSTREAM}"`), `${url}: provenance does not link the upstream`);
    }
  });

  test('the mark links home, and the instance\'s own surfaces are Registry, Catalog, Workspace', async () => {
    asInstance();
    const page = await html(instanceApp, '/padi.light');
    assert.match(page, /<a class="brand" href="\/">/);
    const nav = page.slice(page.indexOf('<nav class="service-nav"'), page.indexOf('</nav>', page.indexOf('<nav class="service-nav"')));
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/', '/profiles', '/workspace']);
  });

  test('the front page reads as a verified copy, and names what it copies', async () => {
    asInstance();
    const page = await html(instanceApp, '/');
    assert.match(page, /A CP Registry instance/);
    assert.match(page, /A verified copy of the CP Registry at <a href="http:\/\/upstream.test">upstream.test<\/a>/);
  });

  test('with no operator configured, the line simply does not name one', async () => {
    asInstance({ operator: null });
    const page = await html(instanceApp, '/padi.light');
    assert.doesNotMatch(page, /class="operator"/);
    assert.ok(page.includes('An instance of the CP Registry following'));
  });
});

describe('the bare frame', () => {
  test('no header, no footer, nothing loaded from another origin — and the provenance line, always', async () => {
    asInstance({ kind: 'bare' });
    for (const url of PAGES) {
      const page = await html(instanceApp, url);
      assert.doesNotMatch(page, /<header|<footer|<nav/, `${url} has chrome`);
      assert.doesNotMatch(page, /\ssrc="|<link /, `${url} loads something`);
      assert.ok(page.includes('From an instance of the CP Registry, operated by'), `${url}: no provenance`);
      assert.match(page, /class="cp-registry"/);
    }
  });
});

describe('under a base path', () => {
  for (const kind of ['instance', 'bare'] as const) {
    test(`${kind}: every local link and form action, on every page, carries the base path`, async () => {
      asInstance({ kind, basePath: '/registry' });
      for (const url of PAGES) {
        const page = await html(instanceApp, url);
        const stray = [...page.matchAll(/\s(?:href|action)="(\/[^"]*)"/g)]
          .map((m) => m[1]!)
          .filter((h) => !h.startsWith('/registry/') && !h.startsWith('//'));
        assert.deepEqual(stray, [], `${url} writes links outside /registry`);
      }
    });
  }

  test('the pill to a held form and the workspace link both sit under the one path', async () => {
    asInstance({ basePath: '/registry' });
    const page = await html(instanceApp, '/workspace');
    assert.ok(page.includes('href="/registry/test.frames.demo:unpublished"'));
    assert.ok(page.includes('href="/registry/workspace"'));
  });
});

describe('what a frame never touches', () => {
  test('machine representations are identical under every frame and base path', async () => {
    const urls: [string, string][] = [
      ['/', 'application/json'],
      ['/profiles?limit=5', 'application/json'],
      ['/padi', 'application/json'],
      ['/padi.light', 'application/cp+json; profile=2026'],
      ['/padi.light:1', 'application/cp+json; profile=2026'],
      ['/padi.light:1', 'application/json'],
      ['/profiles/padi.light', '*/*'],
      ['/test.frames.demo:unpublished', 'application/cp+json; profile=2026'],
    ];
    const snapshot = async () => {
      const out: string[] = [];
      for (const [url, accept] of urls) {
        const r = await instanceApp.inject({ method: 'GET', url, headers: { accept } });
        out.push(`${url} ${r.statusCode} ${r.headers['etag'] ?? ''} ${r.headers['content-digest'] ?? ''} ${r.body}`);
      }
      return out;
    };
    resetFraming();
    const site = await snapshot();
    asInstance({ kind: 'bare', basePath: '/registry' });
    assert.deepEqual(await snapshot(), site);
    asInstance();
    assert.deepEqual(await snapshot(), site);
  });
});
