/**
 * The workspace beside an instance — design §20.3; spec §6.3, §7.1, §7.3, §5.3.
 *
 * The same two databases as distribution.test.ts — an authoritative store
 * with the real corpus, and an instance that follows it — with the instance
 * running a workspace for the operator organization and admitting test.*.
 *
 * The questions worth asking:
 *   - with a workspace beside it, does the instance's REGISTRY surface still
 *     answer every machine representation byte-for-byte as canon does?
 *   - is a form ever mistakable for a version — selected by a bare name, on
 *     the legacy alias, carrying a Content-Digest, cached as immutable?
 *   - can the workspace hold anything but its own organization's names and
 *     test.*? (No.)
 *   - does a workspace write leave any trace in the feed? (None.)
 *   - do co-authors lose each other's edits? (If-Match says no.)
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
import { registerAuthoringRoutes, type Credential } from '../src/part-two/routes.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { registerInstanceRefusals } from '../src/distribution/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { transferTlp } from '../src/part-one/transfer.ts';
import { bootstrap, sync, type Fetch } from '../src/distribution/follower.ts';
import { createWorkspace } from '../src/workspace/routes.ts';
import { sweep } from '../src/workspace/store.ts';
import { workspaceCredentialsFromEnv, mayWriteWorkspace } from '../src/workspace/credential.ts';
import { workspaceConfigFromEnv } from '../src/workspace/config.ts';
import { contentHash } from '../src/profile/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')));

const OPERATOR: Credential = {
  token: 'operator-'.padEnd(40, 'o'),
  userId: '',
  kind: 'agent',
  principal: 'anto@padi.io',
  scopes: ['register', 'steward', 'release', 'publish', 'deprecate', 'operator'],
};
const auth = () => ({ authorization: `Bearer ${OPERATOR.token}` });

const WS_TOKEN = 'workspace-'.padEnd(48, 'w');
const WS_TOKEN_2 = 'assistant-'.padEnd(48, 'a');
const ws = (token = WS_TOKEN, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

const SPEC = 'application/cp+json; profile=2026';
const UPSTREAM = 'http://upstream.test';

let authoritative: Harness;
let instance: Harness;
let upstreamApp: FastifyInstance;
let instanceApp: FastifyInstance;
let operatorOrgId: string;
const config = { orgs: [] as string[], test: true };

function fetchVia(app: FastifyInstance): Fetch {
  return async (url) => {
    const path = url.startsWith(UPSTREAM) ? url.slice(UPSTREAM.length) : url;
    const response = await app.inject({ method: 'GET', url: path });
    return { status: response.statusCode, json: async () => response.json() };
  };
}

function document(name: string, properties: Record<string, unknown>[], title = 'A form in the workspace') {
  return {
    Header: {
      Name: name,
      Owner: 'Padi, Inc.',
      Title: title,
      Provider: 'Sensor',
      Consumer: 'Display',
      Description: 'Saved on the instance; never in the feed.',
      Website: 'https://padi.io/forms',
    },
    Properties: { Provider: properties, Consumer: [] },
  };
}
const p1 = { Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' };
const p2 = { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' };

async function catchUp(): Promise<void> {
  await sync(instance.pool, fetchVia(upstreamApp));
  await sweep(instance.pool, config);
}

before(async () => {
  authoritative = await freshDatabase();
  instance = await freshDatabase({ workspace: true });

  const client = await authoritative.pool.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    operatorOrgId = seeded.orgId;
    await runImport(client, corpus, planImport(corpus));
    const user = await client.query<{ id: string }>(
      `INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|operator', 'anto@padi.io') RETURNING id`,
    );
    OPERATOR.userId = user.rows[0]!.id;
    await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [seeded.orgId, OPERATOR.userId]);
    // onuma leaves the operator's custody, so the workspace has a name held
    // by SOMEONE ELSE to refuse.
    const out = await transferTlp(client, {
      tlp: 'onuma',
      to: 'Onuma, Inc.',
      create: true,
      evidence: 'test: released to its claimant',
      actor: { id: 'anto@padi.io', kind: 'operator', principal: 'anto@padi.io' },
    });
    assert.equal(out.transferred, true, JSON.stringify(out));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  config.orgs = [operatorOrgId];

  upstreamApp = Fastify();
  await registerAuthoringRoutes(upstreamApp, {
    pool: authoritative.pool,
    ownership: new PgOwnershipStore(authoritative.pool),
    credentials: [OPERATOR],
  });
  await registerResolutionRoutes(upstreamApp, { db: authoritative.pool });
  await upstreamApp.ready();

  await bootstrap(instance.pool, UPSTREAM, fetchVia(upstreamApp));
  await sync(instance.pool, fetchVia(upstreamApp));

  const credentials = workspaceCredentialsFromEnv({
    CP_WORKSPACE_TOKENS: `anto=${WS_TOKEN},claude=${WS_TOKEN_2}`,
    CP_WORKSPACE_PRINCIPAL: 'anto@padi.io',
  });
  const workspace = createWorkspace({ db: instance.pool, config, credentials, upstream: UPSTREAM });

  instanceApp = Fastify();
  await registerResolutionRoutes(instanceApp, { db: instance.pool, role: 'instance', upstream: UPSTREAM, workspace: workspace.hooks });
  workspace.register(instanceApp);
  registerInstanceRefusals(instanceApp, UPSTREAM);
  await instanceApp.ready();
});

after(async () => {
  await upstreamApp.close();
  await instanceApp.close();
  await authoritative.close();
  await instance.close();
});

/** The machine representations of every Registry URL — what §20.3 promises stays byte-identical. */
async function machineSurface(app: FastifyInstance): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const index = await app.inject({ method: 'GET', url: '/', headers: { accept: 'application/json' } });
  out.set('/', index.body);
  const catalog = await app.inject({ method: 'GET', url: '/profiles?limit=200', headers: { accept: 'application/json' } });
  out.set('/profiles', catalog.body);
  for (const a of (index.json() as { allocations: { tlp: string }[] }).allocations) {
    if (a.tlp === 'health' || a.tlp === 'workspace') continue; // reserved paths shadow these two allocation pages by design
    const r = await app.inject({ method: 'GET', url: `/${a.tlp}`, headers: { accept: 'application/json' } });
    out.set(`/${a.tlp}`, r.body);
  }
  for (const e of (catalog.json() as { entries: { name: string; versions: { version: number }[] }[] }).entries) {
    const selection = await app.inject({ method: 'GET', url: `/${e.name}`, headers: { accept: SPEC } });
    out.set(`/${e.name}`, selection.body);
    const registration = await app.inject({ method: 'GET', url: `/${e.name}/registration` });
    out.set(`/${e.name}/registration`, registration.body);
    for (const accept of ['application/json']) {
      const r = await app.inject({ method: 'GET', url: `/${e.name}:unpublished`, headers: { accept } });
      out.set(`${accept} /${e.name}:unpublished`, `${r.statusCode} ${r.body}`);
    }
    for (const v of e.versions) {
      for (const accept of [SPEC, 'application/json']) {
        const r = await app.inject({ method: 'GET', url: `/${e.name}:${v.version}`, headers: { accept } });
        out.set(`${accept} /${e.name}:${v.version}`, `${r.statusCode} ${r.headers['content-digest']} ${r.headers['x-cp-status']} ${r.body}`);
      }
    }
  }
  return out;
}

function assertSameSurface(a: Map<string, string>, b: Map<string, string>): void {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'the two hosts answer for different sets of URLs');
  for (const [url, body] of a) assert.equal(b.get(url), body, `differs at ${url}`);
}

/**
 * The journal from the instance's bootstrap point — the stretch both hosts
 * serve (§20.1) — as the chain: every (seq, action, event_hash) and the head.
 * Compared as values rather than bytes because the instance serves its copy
 * from JSONB, which keeps the entries and not their key order.
 */
async function journalChain(app: FastifyInstance): Promise<string> {
  const probe = await instanceApp.inject({ method: 'GET', url: '/distribution/journal?since=0&limit=1' });
  const since = probe.statusCode === 416 ? (probe.json() as { earliest_seq: number }).earliest_seq : 0;
  const r = await app.inject({ method: 'GET', url: `/distribution/journal?since=${since}&limit=1000` });
  assert.equal(r.statusCode, 200, r.body);
  const page = r.json() as { entries: { seq: number; action: string; event_hash: string }[]; head?: unknown };
  // Once a form is PUBLISHED its content is in the feed — by the author's act
  // at canon, which is the only road there. What the workspace itself never
  // adds is an ACT: every entry is one of the Registry's own.
  for (const e of page.entries) assert.match(e.action, /^(profile|allocation|organization|member|credential|user|anchor)\./, `a foreign act at seq ${e.seq}: ${e.action}`);
  return JSON.stringify({ chain: page.entries.map((e) => [e.seq, e.action, e.event_hash]), head: page.head });
}

describe('the credential (§20.3)', () => {
  test('reads the environment form, and refuses a half-configured one', () => {
    assert.deepEqual(workspaceCredentialsFromEnv({}), []);
    assert.throws(() => workspaceCredentialsFromEnv({ CP_WORKSPACE_TOKEN: WS_TOKEN }), /CP_WORKSPACE_PRINCIPAL/);
    assert.throws(() => workspaceCredentialsFromEnv({ CP_WORKSPACE_TOKEN: 'short', CP_WORKSPACE_PRINCIPAL: 'a@b' }), /shorter than 32/);
    assert.throws(
      () => workspaceCredentialsFromEnv({ CP_WORKSPACE_TOKENS: `x=${WS_TOKEN},x=${WS_TOKEN_2}`, CP_WORKSPACE_PRINCIPAL: 'a@b' }),
      /used twice/,
    );
    const one = workspaceCredentialsFromEnv({ CP_WORKSPACE_TOKEN: WS_TOKEN, CP_WORKSPACE_PRINCIPAL: 'anto@padi.io' });
    assert.deepEqual(one, [{ token: WS_TOKEN, label: 'workspace', principal: 'anto@padi.io' }]);
    assert.equal(mayWriteWorkspace(one, `Bearer ${WS_TOKEN}`)?.label, 'workspace');
    assert.equal(mayWriteWorkspace(one, `Bearer ${WS_TOKEN_2}`), null);
    assert.equal(mayWriteWorkspace(one, undefined), null);
  });

  test('the configuration: ids only, off with nothing set', () => {
    assert.equal(workspaceConfigFromEnv({}), null);
    assert.deepEqual(workspaceConfigFromEnv({ WORKSPACE_TEST: 'true' }), { orgs: [], test: true });
    assert.throws(() => workspaceConfigFromEnv({ WORKSPACE_ORGS: 'Padi, Inc.' }), /not an organization id/);
  });
});

describe('what the workspace holds (§20.3)', () => {
  test('a form for a name the organization holds: saved, served, marked', async () => {
    const put = await upstreamApp.inject({ method: 'PUT', url: '/padi.ws', headers: auth() });
    assert.equal(put.statusCode, 201, put.body);
    await catchUp();

    const nothing = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } });
    assert.equal(nothing.statusCode, 404, 'no form yet: the Registry answer stands');

    const doc = { ...document('padi.ws', [p1]), Header: { ...document('padi.ws', [p1]).Header, Version: '7', Status: 'Published', 'Pub Date': '2020-01-01' } };
    const save = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(), payload: doc });
    assert.equal(save.statusCode, 201, save.body);
    assert.equal(save.headers['x-cp-surface'], 'workspace');
    assert.equal(save.headers['cache-control'], 'no-store');
    const saved = save.json() as { content_hash: string; updated_by: string; held_as: string; created: boolean };
    assert.equal(saved.created, true);
    assert.equal(saved.held_as, 'Padi, Inc.');
    assert.equal(saved.updated_by, 'anto (anto@padi.io)');
    assert.equal(save.headers['etag'], `"${saved.content_hash}"`);

    const got = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } });
    assert.equal(got.statusCode, 200, got.body);
    assert.match(String(got.headers['content-type']), /^application\/cp\+json; profile="?2026"?/);
    assert.equal(got.headers['x-cp-surface'], 'workspace');
    assert.equal(got.headers['x-cp-status'], 'unpublished');
    assert.equal(got.headers['cache-control'], 'no-store');
    assert.equal(got.headers['etag'], `"${saved.content_hash}"`);
    assert.equal(got.headers['content-digest'], undefined, 'nothing that claims immutability');
    const body = got.json() as { Header: Record<string, unknown> };
    assert.equal(body.Header['Status'], 'Unpublished');
    assert.equal(body.Header['Version'], undefined, 'the author\'s claimed Version is dropped');
    assert.equal(body.Header['Pub Date'], undefined);
    assert.equal(body.Header['Name'], 'padi.ws');
    assert.deepEqual(Object.keys(body.Header).slice(0, 2), ['Name', 'Status']);
    // The ETag is the hash of the STORED form (stamped fields removed), so a client can compute it.
    const { Status: _s, ...rest } = body.Header;
    assert.equal(contentHash({ ...body, Header: rest }), saved.content_hash);

    const wildcard = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished' });
    assert.equal(wildcard.statusCode, 200, 'a wildcard Accept lands on the 2026 shape (§19.2)');

    const notModified = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC, 'if-none-match': got.headers['etag'] as string } });
    assert.equal(notModified.statusCode, 304);
  });

  test('never selected by the bare name, never on the legacy alias, never in the feed', async () => {
    const bare = await instanceApp.inject({ method: 'GET', url: '/padi.ws', headers: { accept: SPEC } });
    assert.equal(bare.statusCode, 200);
    assert.deepEqual((bare.json() as { versions: unknown[] }).versions, [], 'the selection surface lists published versions only (spec §8.6)');
    const canon = await upstreamApp.inject({ method: 'GET', url: '/padi.ws', headers: { accept: SPEC } });
    assert.equal(bare.body, canon.body, 'byte-identical to canon');

    const legacy = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: 'application/json' } });
    assert.equal(legacy.statusCode, 404, 'the 2022 shape has no Unpublished status to carry');
    const alias = await instanceApp.inject({ method: 'GET', url: '/profiles/padi.ws:unpublished' });
    assert.equal(alias.statusCode, 404);
    const canonLegacy = await upstreamApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: 'application/json' } });
    assert.equal(legacy.body, canonLegacy.body);

    const journal = await instanceApp.inject({ method: 'GET', url: '/distribution/journal?since=0&limit=1000' });
    assert.ok(!journal.body.includes('workspace'), 'no trace of the workspace in the journal');
    assert.ok(!journal.body.includes('A form in the workspace'));
    const snapshot = await upstreamApp.inject({ method: 'GET', url: '/distribution/snapshot' });
    assert.ok(!snapshot.body.includes('A form in the workspace'));
  });

  test('the Registry surface stays byte-identical to canon with a workspace beside it', async () => {
    assertSameSurface(await machineSurface(upstreamApp), await machineSurface(instanceApp));
  });

  test('a test.* form: admitted, marked as such, listed, absent from the mirror', async () => {
    const save = await instanceApp.inject({ method: 'PUT', url: '/test.lab.probe:unpublished', headers: ws(WS_TOKEN_2), payload: document('test.lab.probe', [p1, p2]) });
    assert.equal(save.statusCode, 201, save.body);
    assert.equal((save.json() as { held_as: string }).held_as, 'test');
    assert.equal((save.json() as { updated_by: string }).updated_by, 'claude (anto@padi.io)');

    const got = await instanceApp.inject({ method: 'GET', url: '/test.lab.probe:unpublished', headers: { accept: SPEC } });
    assert.equal(got.statusCode, 200);
    const bare = await instanceApp.inject({ method: 'GET', url: '/test.lab.probe', headers: { accept: SPEC } });
    assert.equal(bare.statusCode, 404, 'nothing under test is ever registered (spec §7.1)');
    const catalog = await instanceApp.inject({ method: 'GET', url: '/profiles?q=test.lab', headers: { accept: 'application/json' } });
    assert.equal((catalog.json() as { total: number }).total, 0, 'not in the catalog: it is not a registered name');

    const index = await instanceApp.inject({ method: 'GET', url: '/workspace', headers: { accept: SPEC } });
    assert.equal(index.statusCode, 200, index.body);
    assert.equal(index.headers['x-cp-surface'], 'workspace');
    const listed = index.json() as { test: boolean; orgs: { name: string }[]; forms: { name: string; held_as: string; published?: unknown }[] };
    assert.equal(listed.test, true);
    assert.equal(listed.orgs[0]?.name, 'Padi, Inc.');
    assert.deepEqual(listed.forms.map((f) => [f.name, f.held_as]), [['padi.ws', 'Padi, Inc.'], ['test.lab.probe', 'test']]);

    const html = await instanceApp.inject({ method: 'GET', url: '/test.lab.probe:unpublished', headers: { accept: 'text/html' } });
    assert.equal(html.statusCode, 200);
    assert.ok(html.body.includes('local exercise'), 'the banner says it is a test.* form');
    assert.ok(html.body.includes('pill current unpublished'));
  });

  test('test.* is refused where not admitted', async () => {
    const strict = { orgs: [operatorOrgId], test: false };
    const workspace = createWorkspace({
      db: instance.pool,
      config: strict,
      credentials: [{ token: WS_TOKEN, label: 'w', principal: 'anto@padi.io' }],
      upstream: UPSTREAM,
    });
    const app = Fastify();
    await registerResolutionRoutes(app, { db: instance.pool, role: 'instance', upstream: UPSTREAM, workspace: workspace.hooks });
    workspace.register(app);
    registerInstanceRefusals(app, UPSTREAM);
    await app.ready();
    try {
      const save = await app.inject({ method: 'PUT', url: '/test.other:unpublished', headers: ws(), payload: document('test.other', [p1]) });
      assert.equal(save.statusCode, 403, save.body);
      assert.equal((save.json() as { code: string }).code, 'workspace.test-not-admitted');
      // A form saved while admitted goes dark once not: the read is the Registry's 404, and the sweep removes it.
      const dark = await app.inject({ method: 'GET', url: '/test.lab.probe:unpublished', headers: { accept: SPEC } });
      assert.equal(dark.statusCode, 404);
      const index = await app.inject({ method: 'GET', url: '/workspace', headers: { accept: SPEC } });
      assert.deepEqual((index.json() as { forms: { name: string }[] }).forms.map((f) => f.name), ['padi.ws']);
    } finally {
      await app.close();
    }
    // Still there for the admitting host — the sweep is the strict host's to run, and it did not.
    const still = await instanceApp.inject({ method: 'GET', url: '/test.lab.probe:unpublished', headers: { accept: SPEC } });
    assert.equal(still.statusCode, 200);
  });

  test('no third class: not another organization\'s name, not an unregistered one, not a malformed one', async () => {
    const theirs = await instanceApp.inject({ method: 'PUT', url: '/onuma.building:unpublished', headers: ws(), payload: document('onuma.building', [p1]) });
    assert.equal(theirs.statusCode, 403, theirs.body);
    assert.equal((theirs.json() as { code: string }).code, 'workspace.not-held');
    assert.ok(theirs.body.includes('Onuma, Inc.'));

    const unregistered = await instanceApp.inject({ method: 'PUT', url: '/padi.never.registered:unpublished', headers: ws(), payload: document('padi.never.registered', [p1]) });
    assert.equal(unregistered.statusCode, 404, unregistered.body);
    assert.equal((unregistered.json() as { code: string }).code, 'workspace.not-registered');

    const unallocated = await instanceApp.inject({ method: 'PUT', url: '/nobody.owns.this:unpublished', headers: ws(), payload: document('nobody.owns.this', [p1]) });
    assert.equal(unallocated.statusCode, 404, unallocated.body);

    const malformed = await instanceApp.inject({ method: 'PUT', url: '/Padi.WS:unpublished', headers: ws(), payload: document('Padi.WS', [p1]) });
    assert.equal(malformed.statusCode, 400, malformed.body);
  });
});

describe('writes (§20.3)', () => {
  test('the credential is required, and a wrong one is refused', async () => {
    const none = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', payload: document('padi.ws', [p1]) });
    assert.equal(none.statusCode, 401);
    assert.equal(none.headers['www-authenticate'], 'Bearer realm="workspace"');
    assert.equal((none.json() as { code: string }).code, 'workspace.auth');
    const wrong = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(OPERATOR.token), payload: document('padi.ws', [p1]) });
    assert.equal(wrong.statusCode, 401, 'a canon token is not a workspace credential');
    const del = await instanceApp.inject({ method: 'DELETE', url: '/padi.ws:unpublished' });
    assert.equal(del.statusCode, 401);
  });

  test('a write to a Registry path is still refused with the authoritative host\'s URL', async () => {
    for (const [method, url] of [['PUT', '/padi.ws'], ['DELETE', '/padi.ws'], ['POST', '/padi.ws/publish'], ['PATCH', '/padi.ws:1/header']] as const) {
      const r = await instanceApp.inject({ method, url, headers: ws(), payload: {} });
      assert.equal(r.statusCode, 405, `${method} ${url}`);
      assert.equal((r.json() as { authoritative: string }).authoritative, UPSTREAM);
    }
  });

  test('Header.Name must be the name; a non-document is refused', async () => {
    const other = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(), payload: document('padi.other', [p1]) });
    assert.equal(other.statusCode, 400, other.body);
    assert.equal((other.json() as { code: string }).code, 'workspace.name-mismatch');
    const list = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(), payload: [1, 2] });
    assert.equal(list.statusCode, 400);
    assert.equal((list.json() as { code: string }).code, 'workspace.not-a-document');
  });

  test('If-Match: required over an existing form, refused when stale, honoured when current', async () => {
    const current = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } });
    const etag = current.headers['etag'] as string;

    const blind = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(), payload: document('padi.ws', [p1, p2]) });
    assert.equal(blind.statusCode, 428, blind.body);
    assert.equal((blind.json() as { code: string }).code, 'workspace.precondition-required');

    const stale = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(WS_TOKEN, { 'if-match': '"0000"' }), payload: document('padi.ws', [p1, p2]) });
    assert.equal(stale.statusCode, 412, stale.body);
    assert.equal((stale.json() as { current: string }).current, etag.replace(/"/g, ''));

    const ok = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(WS_TOKEN_2, { 'if-match': etag }), payload: document('padi.ws', [p1, p2]) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((ok.json() as { created: boolean; updated_by: string }).created, false);
    assert.equal((ok.json() as { updated_by: string }).updated_by, 'claude (anto@padi.io)');
    assert.notEqual(ok.headers['etag'], etag);

    // The first author, holding the old ETag, is told rather than overwriting the co-author.
    const lost = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(WS_TOKEN, { 'if-match': etag }), payload: document('padi.ws', [p1]) });
    assert.equal(lost.statusCode, 412);

    // A first save with an If-Match has nothing to match.
    const first = await instanceApp.inject({ method: 'PUT', url: '/padi.ws2:unpublished', headers: ws(WS_TOKEN, { 'if-match': etag }), payload: document('padi.ws2', [p1]) });
    assert.equal(first.statusCode, 404, 'padi.ws2 is not registered, so the organization rule answers first');
  });
});

describe('the human pages (§20.3)', () => {
  test('the name page gains the pill; the version page too; the catalog and allocation pages link', async () => {
    const name = await instanceApp.inject({ method: 'GET', url: '/padi.ws', headers: { accept: 'text/html' } });
    assert.equal(name.statusCode, 200);
    assert.ok(name.body.includes('class="pill unpublished" href="/padi.ws:unpublished"'), 'the pill');
    assert.ok(name.body.includes('held in the workspace on this host'));
    const canonName = await upstreamApp.inject({ method: 'GET', url: '/padi.ws', headers: { accept: 'text/html' } });
    assert.ok(!canonName.body.includes('pill unpublished'), 'canon has no pill to show');

    const catalog = await instanceApp.inject({ method: 'GET', url: '/profiles?q=padi.ws', headers: { accept: 'text/html' } });
    assert.ok(catalog.body.includes('href="/padi.ws:unpublished"'), 'the catalog links to the form');
    const allocation = await instanceApp.inject({ method: 'GET', url: '/padi', headers: { accept: 'text/html' } });
    assert.ok(allocation.body.includes('href="/padi.ws:unpublished"'), 'the allocation page links to the form');

    const form = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: 'text/html' } });
    assert.equal(form.statusCode, 200);
    assert.equal(form.headers['x-cp-surface'], 'workspace');
    assert.ok(form.body.includes('cp:padi.ws:unpublished'));
    assert.ok(form.body.includes('not by the Registry'));
    assert.ok(form.body.includes('provisional'));
    assert.ok(form.body.includes('held by <strong>Padi, Inc.</strong>'));
    assert.ok(form.body.includes('<strong>units</strong>'), 'every Property, drawn by the same renderer');
    assert.ok(form.body.includes('<h2>Header</h2>'));
  });

  test('after publication the form persists and the pill says where it stands', async () => {
    // Publish the CURRENT form as version 1 — the author's act, at canon, carrying the content.
    const current = (await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } })).json() as Record<string, unknown>;
    const pub = await upstreamApp.inject({ method: 'POST', url: '/padi.ws/publish', headers: auth(), payload: current });
    assert.equal(pub.statusCode, 201, pub.body);
    await catchUp();

    const still = await instanceApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } });
    assert.equal(still.statusCode, 200, 'the unpublished form persists after publication (spec §6.3)');

    const same = await instanceApp.inject({ method: 'GET', url: '/padi.ws:1', headers: { accept: 'text/html' } });
    assert.ok(same.body.includes('Unpublished &middot; same as v1'), same.body.slice(0, 0) || 'the pill on the version page');

    const etag = still.headers['etag'] as string;
    const moved = await instanceApp.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(WS_TOKEN, { 'if-match': etag }), payload: document('padi.ws', [p1, p2], 'Grown since v1') });
    assert.equal(moved.statusCode, 200, moved.body);
    const page = await instanceApp.inject({ method: 'GET', url: '/padi.ws', headers: { accept: 'text/html' } });
    assert.ok(page.body.includes('Unpublished &middot; moved on since v1'));

    const index = await instanceApp.inject({ method: 'GET', url: '/workspace', headers: { accept: SPEC } });
    const entry = (index.json() as { forms: { name: string; published?: { version: number; same: boolean } }[] }).forms.find((f) => f.name === 'padi.ws');
    assert.deepEqual(entry?.published, { version: 1, same: false });

    // And the machine surface of the Registry is still canon's.
    assertSameSurface(await machineSurface(upstreamApp), await machineSurface(instanceApp));
  });

  test('/health and /distribution/status show the second hat', async () => {
    const health = await instanceApp.inject({ method: 'GET', url: '/health' });
    const ws = (health.json() as { workspace: { orgs: { name: string }[]; test: boolean; forms: number; index: string } }).workspace;
    assert.equal(ws.orgs[0]?.name, 'Padi, Inc.');
    assert.equal(ws.test, true);
    assert.equal(ws.index, '/workspace');
    const status = await instanceApp.inject({ method: 'GET', url: '/distribution/status' });
    assert.equal((status.json() as { role: string }).role, 'instance');
    assert.ok((status.json() as { workspace?: unknown }).workspace);
    const canon = await upstreamApp.inject({ method: 'GET', url: '/health' });
    assert.equal((canon.json() as { workspace?: unknown }).workspace, undefined, 'canon has no second hat');
  });
});

describe('release and the sweep (§20.3)', () => {
  test('a released name\'s form goes dark at once and is swept on the next sync; the journal is untouched by any of it', async () => {
    const before = await journalChain(instanceApp);

    const put = await upstreamApp.inject({ method: 'PUT', url: '/padi.ws.gone', headers: auth() });
    assert.equal(put.statusCode, 201, put.body);
    await catchUp();
    const save = await instanceApp.inject({ method: 'PUT', url: '/padi.ws.gone:unpublished', headers: ws(), payload: document('padi.ws.gone', [p1]) });
    assert.equal(save.statusCode, 201, save.body);

    const del = await upstreamApp.inject({ method: 'DELETE', url: '/padi.ws.gone', headers: auth() });
    assert.equal(del.statusCode, 204, del.body);
    await sync(instance.pool, fetchVia(upstreamApp)); // applied, not yet swept

    const dark = await instanceApp.inject({ method: 'GET', url: '/padi.ws.gone:unpublished', headers: { accept: SPEC } });
    assert.equal(dark.statusCode, 404, 'dark: the name is no longer one the organization holds');
    const rows = await instance.pool.query(`SELECT 1 FROM workspace_profile WHERE name = 'padi.ws.gone'`);
    assert.equal(rows.rowCount, 1, 'the row is still there until the sweep');

    const swept = await sweep(instance.pool, config);
    assert.deepEqual(swept, ['padi.ws.gone']);
    const after = await instance.pool.query(`SELECT 1 FROM workspace_profile WHERE name = 'padi.ws.gone'`);
    assert.equal(after.rowCount, 0);

    // Everything the workspace did in this file left the journal exactly as the acts at canon made it.
    const now = await journalChain(instanceApp);
    const canon = await journalChain(upstreamApp);
    assert.equal(now, canon);
    assert.notEqual(now, before, 'the register and release at canon did reach the journal');
  });

  test('DELETE removes a form; a second DELETE is 404', async () => {
    const del = await instanceApp.inject({ method: 'DELETE', url: '/test.lab.probe:unpublished', headers: ws() });
    assert.equal(del.statusCode, 204);
    const again = await instanceApp.inject({ method: 'DELETE', url: '/test.lab.probe:unpublished', headers: ws() });
    assert.equal(again.statusCode, 404);
    const gone = await instanceApp.inject({ method: 'GET', url: '/test.lab.probe:unpublished', headers: { accept: SPEC } });
    assert.equal(gone.statusCode, 404);
  });
});

describe('without a workspace (§20.1)', () => {
  test('an instance configured with none answers :unpublished exactly as canon does', async () => {
    const plain = Fastify();
    await registerResolutionRoutes(plain, { db: instance.pool, role: 'instance', upstream: UPSTREAM });
    registerInstanceRefusals(plain, UPSTREAM);
    await plain.ready();
    try {
      const r = await plain.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } });
      const c = await upstreamApp.inject({ method: 'GET', url: '/padi.ws:unpublished', headers: { accept: SPEC } });
      assert.equal(r.statusCode, 404);
      assert.equal(r.body, c.body);
      const w = await plain.inject({ method: 'PUT', url: '/padi.ws:unpublished', headers: ws(), payload: document('padi.ws', [p1]) });
      assert.equal(w.statusCode, 405, 'no write surface at all');
      // No index: the dotless path falls through to the allocation route —
      // which, `workspace` being withheld as path-shadowing (§3.2), answers
      // for the operator's custodial allocation, never for a workspace.
      const index = await plain.inject({ method: 'GET', url: '/workspace', headers: { accept: 'application/json' } });
      assert.equal(index.headers['x-cp-surface'], undefined);
      assert.notEqual((index.json() as { surface?: string }).surface, 'workspace');
      const health = await plain.inject({ method: 'GET', url: '/health' });
      assert.equal((health.json() as { workspace?: unknown }).workspace, undefined);
    } finally {
      await plain.close();
    }
  });
});
