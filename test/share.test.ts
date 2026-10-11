/**
 * Sharing a form — design §20.3, "Sharing a form"; spec §5.3, §6.3, §7.3.
 *
 * One authoritative store and two instances that follow it:
 *   - the AUTHOR's host (https://author.test), whose workspace holds the
 *     operator organization's names and admits test.*;
 *   - a PARTNER's host (https://partner.test), whose workspace holds Onuma,
 *     Inc.'s names and admits test.*.
 *
 * The questions worth asking:
 *   - does a form shared by file or by link arrive as exactly what was
 *     shared, marked with where it came from, and never as a version?
 *   - is a shared copy ever editable on the partner's host? (No.)
 *   - does a host ever overwrite its own work with someone else's? (No.)
 *   - does a link import fetch anything but a workspace answer, over
 *     anything but HTTPS, through a redirect? (No.)
 *   - with shared copies beside it, does the partner's REGISTRY surface still
 *     answer as canon does, and does anything reach the feed? (Yes; nothing.)
 *   - is anything deleted automatically? (No — a released name's copy goes
 *     dark and is kept.)
 */

import { test, describe, before, after } from 'node:test';
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
import { registerAuthoringRoutes, type Credential } from '../src/part-two/routes.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { registerInstanceRefusals } from '../src/distribution/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { transferTlp } from '../src/part-one/transfer.ts';
import { bootstrap, sync, type Fetch } from '../src/distribution/follower.ts';
import { createWorkspace } from '../src/workspace/routes.ts';
import { darkForms, getForm } from '../src/workspace/store.ts';
import { workspaceCredentialsFromEnv } from '../src/workspace/credential.ts';
import { CARRIER_FORMAT, parseLink, type LinkFetch, type LinkResponse } from '../src/workspace/carrier.ts';
import { asMember } from './support/members.ts';

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

const AUTHOR_TOKEN = 'author-'.padEnd(48, 'a');
const PARTNER_TOKEN = 'partner-'.padEnd(48, 'p');
const asAuthor = () => ({ authorization: `Bearer ${AUTHOR_TOKEN}` });
const asPartner = () => ({ authorization: `Bearer ${PARTNER_TOKEN}` });

const SPEC = 'application/cp+json; profile=2026';
const UPSTREAM = 'http://upstream.test';
const AUTHOR = 'https://author.test';
const PARTNER = 'https://partner.test';

let authoritative: Harness;
let authorDb: Harness;
let partnerDb: Harness;
let upstreamApp: FastifyInstance;
let authorApp: FastifyInstance;
let partnerApp: FastifyInstance;

/** What the partner's host fetched, and a hook to answer instead of the author's host. */
const fetched: string[] = [];
let linkOverride: ((url: URL) => LinkResponse | null) | null = null;

function fetchVia(app: FastifyInstance): Fetch {
  return async (url) => {
    const path = url.startsWith(UPSTREAM) ? url.slice(UPSTREAM.length) : url;
    const response = await app.inject({ method: 'GET', url: path });
    return { status: response.statusCode, json: async () => response.json() };
  };
}

/** The partner's link fetch: https://author.test goes to the author's app, by inject; nothing else is reachable. */
const partnerFetch: LinkFetch = async (url) => {
  fetched.push(url.toString());
  const overridden = linkOverride?.(url);
  if (overridden) return overridden;
  const apps: Record<string, FastifyInstance> = { [AUTHOR]: authorApp, [PARTNER]: partnerApp };
  const app = apps[url.origin];
  if (!app) throw new Error('connect ECONNREFUSED');
  const r = await app.inject({ method: 'GET', url: url.pathname, headers: { accept: SPEC } });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers[k.toLowerCase()] = String(v);
  return { status: r.statusCode, headers, body: r.body };
};

function document(name: string, title = 'A shared form') {
  return {
    Header: {
      Name: name,
      Owner: 'Padi, Inc.',
      Title: title,
      Provider: 'Sensor',
      Consumer: 'Display',
      Description: 'Shared between two workspaces; never in the feed.',
    },
    Properties: { Provider: [{ Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' }], Consumer: [] },
  };
}

async function register(name: string): Promise<void> {
  const put = await upstreamApp.inject({ method: 'PUT', url: `/${name}`, headers: auth() });
  assert.ok(put.statusCode === 201 || put.statusCode === 200, put.body);
  await sync(authorDb.pool, fetchVia(upstreamApp));
  await sync(partnerDb.pool, fetchVia(upstreamApp));
}

async function share(name: string): Promise<Record<string, unknown>> {
  const r = await authorApp.inject({ method: 'GET', url: `/workspace/share/${name}` });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as Record<string, unknown>;
}

async function importOn(app: FastifyInstance, token: () => Record<string, string>, body: unknown) {
  const r = await app.inject({ method: 'POST', url: '/workspace/import', headers: token(), payload: body as object });
  return r;
}

type Row = { name: string; as?: string; holder?: string | null; outcome: string; refusal?: string; current?: string; applied: boolean; detail?: string };

before(async () => {
  authoritative = await freshDatabase();
  authorDb = await freshDatabase({ workspace: true });
  partnerDb = await freshDatabase({ workspace: true });

  let operatorOrgId = '';
  const client = await authoritative.pool.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    operatorOrgId = seeded.orgId;
    await runImport(client, corpus, planImport(corpus));
    const user = await client.query<{ id: string }>(`INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|operator', 'anto@padi.io') RETURNING id`);
    OPERATOR.userId = user.rows[0]!.id;
    await asMember(client, seeded.orgId, OPERATOR.userId, 'admin');
    const out = await transferTlp(client, {
      tlp: 'onuma',
      to: 'Onuma, Inc.',
      create: true,
      evidence: 'test: the partner organization',
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

  upstreamApp = Fastify();
  await registerAuthoringRoutes(upstreamApp, { pool: authoritative.pool, ownership: new PgOwnershipStore(authoritative.pool), credentials: [OPERATOR] });
  await registerResolutionRoutes(upstreamApp, { db: authoritative.pool });
  await upstreamApp.ready();

  for (const db of [authorDb, partnerDb]) {
    await bootstrap(db.pool, UPSTREAM, fetchVia(upstreamApp));
    await sync(db.pool, fetchVia(upstreamApp));
  }
  const onuma = await partnerDb.pool.query<{ id: string }>(`SELECT id FROM organization WHERE name = 'Onuma, Inc.'`);
  const onumaId = onuma.rows[0]!.id;

  async function host(db: Harness, orgs: string[], token: string, publicUrl: string, operator: string): Promise<FastifyInstance> {
    const credentials = workspaceCredentialsFromEnv({ CP_WORKSPACE_TOKENS: `ws=${token}`, CP_WORKSPACE_PRINCIPAL: 'someone@example.test' });
    const workspace = createWorkspace({
      db: db.pool,
      config: { orgs, test: true },
      credentials,
      upstream: UPSTREAM,
      catchUp: async () => {
        await sync(db.pool, fetchVia(upstreamApp));
      },
      publicUrl,
      operator,
      fetchLink: partnerFetch,
    });
    const app = Fastify();
    await registerResolutionRoutes(app, { db: db.pool, role: 'instance', upstream: UPSTREAM, workspace: workspace.hooks });
    workspace.register(app);
    registerInstanceRefusals(app, UPSTREAM);
    await app.ready();
    return app;
  }
  authorApp = await host(authorDb, [operatorOrgId], AUTHOR_TOKEN, AUTHOR, 'Padi, Inc.');
  partnerApp = await host(partnerDb, [onumaId], PARTNER_TOKEN, PARTNER, 'Onuma, Inc.');

  // The author's working forms.
  for (const name of ['padi.share', 'padi.share.link', 'padi.share.gone']) {
    await register(name);
    const save = await authorApp.inject({ method: 'PUT', url: `/${name}:unpublished`, headers: asAuthor(), payload: document(name) });
    assert.equal(save.statusCode, 201, save.body);
  }
});

after(async () => {
  for (const app of [upstreamApp, authorApp, partnerApp]) await app.close();
  for (const db of [authoritative, authorDb, partnerDb]) await db.close();
});

describe('Share (§20.3, "Sharing a form")', () => {
  test('the file is a carrier: the served bytes, their ETag, where it came from — and nothing else', async () => {
    const r = await authorApp.inject({ method: 'GET', url: '/workspace/share/padi.share' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-disposition'], 'attachment; filename="padi.share.cp.json"');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-cp-surface'], 'workspace');
    const carrier = r.json() as { carrier: string; shared: { from: string; via: string[]; operator: string }; items: { name: string; kind: string; etag: string; document: unknown }[] };
    assert.equal(carrier.carrier, CARRIER_FORMAT);
    assert.equal(carrier.shared.from, AUTHOR);
    assert.deepEqual(carrier.shared.via, []);
    assert.equal(carrier.shared.operator, 'Padi, Inc.');
    assert.equal(carrier.items.length, 1);
    const served = await authorApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: SPEC } });
    assert.deepEqual(carrier.items[0]!.document, served.json(), 'the document is exactly what the form address serves');
    assert.equal(carrier.items[0]!.etag, served.headers['etag']);
    assert.equal(carrier.items[0]!.kind, 'unpublished');
  });

  test('Share is open, like every read; a form the host does not hold is not shared', async () => {
    const missing = await authorApp.inject({ method: 'GET', url: '/workspace/share/padi.nothing.here' });
    assert.equal(missing.statusCode, 404);
    const elsewhere = await partnerApp.inject({ method: 'GET', url: '/workspace/share/padi.share' });
    assert.equal(elsewhere.statusCode, 404, 'the partner holds nothing yet');
  });

  test('the page offers the link to copy and the file to download', async () => {
    const r = await authorApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: 'text/html' } });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /<details class="share"><summary>Share<\/summary>/);
    assert.ok(r.body.includes(`value="${AUTHOR}/padi.share:unpublished"`), 'the link is the form\'s own address on this host');
    assert.ok(r.body.includes('href="/workspace/share/padi.share"'));
    assert.ok(r.body.includes(`data-copy="${AUTHOR}/padi.share:unpublished"`), 'clicking the link copies it, for the partner\'s Import');
    assert.ok(r.body.includes(`href="${AUTHOR}/padi.share:unpublished"`), 'and without a script it is still the link');
  });
});

describe('Import by file (§20.3)', () => {
  test('preview writes nothing; apply lands a shared copy, served as the author served it, marked with its origin', async () => {
    const carrier = await share('padi.share');
    const preview = await importOn(partnerApp, asPartner, { source: carrier });
    assert.equal(preview.statusCode, 200, preview.body);
    const p = preview.json() as { apply: boolean; items: Row[]; origin: { from: string; verified: boolean } };
    assert.equal(p.apply, false);
    assert.deepEqual(p.origin, { from: AUTHOR, verified: false, via: [] }, 'a file\'s origin is only ever as stated');
    assert.equal(p.items[0]!.outcome, 'new');
    assert.equal(p.items[0]!.as, 'shared');
    assert.equal(p.items[0]!.holder, 'Padi, Inc.', 'the holder is the mirror\'s');
    assert.equal(p.items[0]!.applied, false);
    assert.equal(await getForm(partnerDb.pool, 'padi.share'), null, 'a preview writes nothing');

    const applied = await importOn(partnerApp, asPartner, { source: carrier, apply: true });
    const a = applied.json() as { applied: number; items: Row[] };
    assert.equal(a.applied, 1, applied.body);
    assert.equal(a.items[0]!.applied, true);

    const theirs = await authorApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: SPEC } });
    const ours = await partnerApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: SPEC } });
    assert.equal(ours.statusCode, 200, ours.body);
    assert.equal(ours.body, theirs.body, 'the same bytes the author served');
    assert.equal(ours.headers['etag'], theirs.headers['etag'], 'pinned to the hash it arrived with');
    assert.equal(ours.headers['x-cp-surface'], 'workspace');
    assert.equal(ours.headers['x-cp-status'], 'unpublished');
    assert.equal(ours.headers['x-cp-shared-from'], AUTHOR);
    assert.equal(ours.headers['cache-control'], 'no-store');
    assert.equal(ours.headers['content-digest'], undefined, 'nothing that claims immutability');

    const again = await importOn(partnerApp, asPartner, { source: carrier });
    assert.equal((again.json() as { items: Row[] }).items[0]!.outcome, 'identical');
  });

  test('a shared copy is never edited here, and never selected by the bare name', async () => {
    const put = await partnerApp.inject({ method: 'PUT', url: '/padi.share:unpublished', headers: asPartner(), payload: document('padi.share', 'Edited by the partner') });
    assert.equal(put.statusCode, 409, put.body);
    assert.equal((put.json() as { code: string }).code, 'workspace.shared-copy-read-only');

    const bare = await partnerApp.inject({ method: 'GET', url: '/padi.share', headers: { accept: SPEC } });
    const canon = await upstreamApp.inject({ method: 'GET', url: '/padi.share', headers: { accept: SPEC } });
    assert.equal(bare.body, canon.body, 'the bare name is canon\'s selection surface, byte for byte');
    const legacy = await partnerApp.inject({ method: 'GET', url: '/profiles/padi.share:unpublished' });
    assert.notEqual(legacy.statusCode, 200, 'never on the legacy alias');
  });

  test('every reader gets the same bytes', async () => {
    const plain = await partnerApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: SPEC } });
    const credentialed = await partnerApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: SPEC, ...asPartner() } });
    const stranger = await partnerApp.inject({ method: 'GET', url: '/padi.share:unpublished', headers: { accept: SPEC, authorization: 'Bearer nobody', 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(plain.body, credentialed.body);
    assert.equal(plain.body, stranger.body);
    assert.ok(!String(plain.headers['vary'] ?? '').toLowerCase().includes('authorization'));
  });

  test('damage, a wrong name, a malformed name, an unregistered name: each refused, each on its own', async () => {
    const carrier = (await share('padi.share.link')) as { items: { name: string; document: { Header: Record<string, unknown> } }[] } & Record<string, unknown>;
    const good = carrier.items[0]!;
    const tampered = structuredClone(good);
    tampered.document.Header['Title'] = 'Changed on the way';
    const misnamed = { ...structuredClone(good), name: 'padi.share.other' };
    const unregistered = { ...structuredClone(good), name: 'padi.never.registered', document: { ...good.document, Header: { ...good.document.Header, Name: 'padi.never.registered' } }, etag: undefined };
    const malformed = { ...structuredClone(good), name: 'Not A Name' };
    const r = await importOn(partnerApp, asPartner, { source: { ...carrier, items: [tampered, misnamed, unregistered, malformed] } });
    assert.equal(r.statusCode, 200, r.body);
    const refusals = (r.json() as { items: Row[] }).items.map((i) => [i.name, i.refusal]);
    assert.deepEqual(refusals, [
      ['padi.share.link', 'hash-mismatch'],
      ['padi.share.other', 'name-mismatch'],
      ['padi.never.registered', 'not-registered'],
      ['Not A Name', 'malformed'],
    ]);
  });

  test('not a carrier at all is refused whole; import takes the workspace credential', async () => {
    const junk = await importOn(partnerApp, asPartner, { source: { carrier: 'something-else/9', items: [] } });
    assert.equal(junk.statusCode, 400);
    const noAuth = await partnerApp.inject({ method: 'POST', url: '/workspace/import', payload: { source: await share('padi.share') } });
    assert.equal(noAuth.statusCode, 401);
    const wrong = await importOn(partnerApp, asAuthor, { source: await share('padi.share') });
    assert.equal(wrong.statusCode, 401, 'the author\'s credential means nothing on the partner\'s host');
  });

  test('a bare Profile document imports with its origin recorded as unknown', async () => {
    await register('padi.share.bare');
    const r = await importOn(partnerApp, asPartner, { source: document('padi.share.bare'), apply: true });
    assert.equal((r.json() as { applied: number }).applied, 1, r.body);
    const got = await partnerApp.inject({ method: 'GET', url: '/padi.share.bare:unpublished', headers: { accept: SPEC } });
    assert.equal(got.headers['x-cp-shared-from'], 'unknown');
    const page = await partnerApp.inject({ method: 'GET', url: '/padi.share.bare:unpublished', headers: { accept: 'text/html' } });
    assert.match(page.body, /arrived as a bare document/);
    assert.match(page.body, /Origin as stated/);
  });
});

describe('Import by link (§20.3)', () => {
  test('the host fetches the link itself, so the origin is verified', async () => {
    fetched.length = 0;
    const r = await importOn(partnerApp, asPartner, { link: `${AUTHOR}/padi.share.link:unpublished`, apply: true });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json() as { origin: { from: string; verified: boolean; link: string }; items: Row[] };
    assert.equal(body.origin.from, AUTHOR);
    assert.equal(body.origin.verified, true);
    assert.equal(body.items[0]!.applied, true);
    assert.deepEqual(fetched, [`${AUTHOR}/padi.share.link:unpublished`]);

    const page = await partnerApp.inject({ method: 'GET', url: '/padi.share.link:unpublished', headers: { accept: 'text/html' } });
    assert.match(page.body, /Origin verified/);
    assert.match(page.body, /Check for update/);
    assert.match(page.body, /Unpublished &middot; shared/);
  });

  test('Check for update: the author saves again; the partner sees "differs" and replaces only on saying so', async () => {
    const current = await authorApp.inject({ method: 'GET', url: '/padi.share.link:unpublished', headers: { accept: SPEC } });
    const save = await authorApp.inject({
      method: 'PUT', url: '/padi.share.link:unpublished',
      headers: { ...asAuthor(), 'if-match': current.headers['etag'] as string },
      payload: document('padi.share.link', 'Revised by the author'),
    });
    assert.equal(save.statusCode, 200, save.body);

    const link = `${AUTHOR}/padi.share.link:unpublished`;
    const preview = (await importOn(partnerApp, asPartner, { link })).json() as { items: Row[] };
    assert.equal(preview.items[0]!.outcome, 'differs');
    const held = preview.items[0]!.current!;
    assert.ok(held);

    const unagreed = (await importOn(partnerApp, asPartner, { link, apply: true })).json() as { items: Row[] };
    assert.equal(unagreed.items[0]!.applied, false, 'nothing is replaced by someone who has not seen what it replaces');

    const agreed = (await importOn(partnerApp, asPartner, { link, apply: true, replace: { 'padi.share.link': held } })).json() as { items: Row[] };
    assert.equal(agreed.items[0]!.applied, true);
    const ours = await partnerApp.inject({ method: 'GET', url: '/padi.share.link:unpublished', headers: { accept: SPEC } });
    assert.equal((ours.json() as { Header: { Title: string } }).Header.Title, 'Revised by the author');
    assert.equal(ours.headers['etag'], save.headers['etag']);
  });

  test('narrow terms: HTTPS, the two shapes, no redirect, a workspace answer, a reachable host', async () => {
    const http = await importOn(partnerApp, asPartner, { link: 'http://author.test/padi.share:unpublished' });
    assert.equal(http.statusCode, 400);
    assert.equal((http.json() as { code: string }).code, 'workspace.link-scheme');

    for (const link of [`${AUTHOR}/padi.share`, `${AUTHOR}/padi.share:1`, `${AUTHOR}/workspace`, `${AUTHOR}/padi.share:unpublished?x=1`, 'not a url']) {
      const r = await importOn(partnerApp, asPartner, { link });
      assert.equal(r.statusCode, 400, `${link}: ${r.body}`);
      assert.equal((r.json() as { code: string }).code, 'workspace.link-shape', link);
    }
    assert.ok(!('refused' in parseLink(`${AUTHOR}/registry/padi.share:unpublished`, { allowHttp: false })), 'any base path');
    assert.ok(!('refused' in parseLink('http://localhost:8080/test.x', { allowHttp: true })), 'plain HTTP only when admitted');

    linkOverride = () => ({ status: 302, headers: { location: 'https://elsewhere.test/' }, body: '' });
    const redirect = await importOn(partnerApp, asPartner, { link: `${AUTHOR}/padi.share:unpublished` });
    assert.equal(redirect.statusCode, 422, redirect.body);

    linkOverride = () => ({ status: 200, headers: { 'content-type': SPEC, etag: '"x"' }, body: JSON.stringify(document('padi.share')) });
    const notWorkspace = await importOn(partnerApp, asPartner, { link: `${AUTHOR}/padi.share:unpublished` });
    assert.equal(notWorkspace.statusCode, 422, 'an answer not marked as a workspace\'s is not a shared form');
    linkOverride = null;

    const unreachable = await importOn(partnerApp, asPartner, { link: 'https://unreachable.test/padi.share:unpublished' });
    assert.equal(unreachable.statusCode, 502);
    assert.match((unreachable.json() as { message: string }).message, /ask for the file instead/);
  });
});

describe('test names (§20.3; spec §7.1)', () => {
  test('a shared test name is registered on the partner\'s host, resolves at its bare name, and is read-only there', async () => {
    const reg = await authorApp.inject({ method: 'PUT', url: '/test.share', headers: asAuthor() });
    assert.equal(reg.statusCode, 201, reg.body);
    const save = await authorApp.inject({ method: 'PUT', url: '/test.share:unpublished', headers: asAuthor(), payload: document('test.share') });
    assert.equal(save.statusCode, 201, save.body);

    const r = await importOn(partnerApp, asPartner, { link: `${AUTHOR}/test.share`, apply: true });
    assert.equal(r.statusCode, 200, r.body);
    const row = (r.json() as { items: Row[] }).items[0]!;
    assert.equal(row.as, 'shared');
    assert.equal(row.applied, true);

    const bare = await partnerApp.inject({ method: 'GET', url: '/test.share', headers: { accept: SPEC } });
    assert.equal(bare.statusCode, 200, bare.body);
    assert.equal(bare.headers['x-cp-shared-from'], AUTHOR);
    const theirs = await authorApp.inject({ method: 'GET', url: '/test.share', headers: { accept: SPEC } });
    assert.equal(bare.body, theirs.body);
    const registration = await partnerApp.inject({ method: 'GET', url: '/test.share/registration' });
    assert.equal(registration.statusCode, 200);

    const put = await partnerApp.inject({ method: 'PUT', url: '/test.share:unpublished', headers: asPartner(), payload: document('test.share', 'mine now') });
    assert.equal(put.statusCode, 409);
  });

  test('never over the host\'s own test name', async () => {
    await partnerApp.inject({ method: 'PUT', url: '/test.mine', headers: asPartner() });
    await authorApp.inject({ method: 'PUT', url: '/test.mine', headers: asAuthor() });
    await authorApp.inject({ method: 'PUT', url: '/test.mine:unpublished', headers: asAuthor(), payload: document('test.mine') });
    const r = await importOn(partnerApp, asPartner, { link: `${AUTHOR}/test.mine`, apply: true });
    const row = (r.json() as { items: Row[] }).items[0]!;
    assert.equal(row.refusal, 'conflicts-own');
    assert.equal(row.applied, false);
  });
});

describe('own work, re-sharing, and the wall (§20.3)', () => {
  test('a host never overwrites its own work: importing the partner\'s copy back onto the author is refused', async () => {
    const r = await importOn(authorApp, asAuthor, { link: `${PARTNER}/padi.share:unpublished` });
    const row = (r.json() as { items: Row[] }).items[0]!;
    assert.equal(row.as, 'own');
    assert.equal(row.outcome, 'identical', 'the copy is the author\'s own form, unchanged');
  });

  test('re-sharing keeps the chain of hands', async () => {
    const r = await partnerApp.inject({ method: 'GET', url: '/workspace/share/padi.share' });
    const carrier = r.json() as { shared: { from: string; via: string[] } };
    assert.equal(carrier.shared.from, AUTHOR);
    assert.deepEqual(carrier.shared.via, [PARTNER]);
  });

  test('the host\'s own name, imported, is own work: saved, editable, and the import recorded', async () => {
    await register('padi.share.lab');
    const lab = {
      carrier: CARRIER_FORMAT,
      shared: { at: new Date().toISOString(), from: 'https://lab.test', via: [], operator: 'Padi, Inc.' },
      items: [{ name: 'padi.share.lab', kind: 'unpublished', etag: '', updated_at: new Date().toISOString(), document: document('padi.share.lab') }],
    };
    delete (lab.items[0] as Record<string, unknown>)['etag'];
    const r = await importOn(authorApp, asAuthor, { source: lab, apply: true });
    const row = (r.json() as { items: Row[] }).items[0]!;
    assert.equal(row.as, 'own', r.body);
    assert.equal(row.applied, true);
    const form = await getForm(authorDb.pool, 'padi.share.lab');
    assert.equal(form?.kind, 'own');
    assert.match(form!.updated_by, /imported from https:\/\/lab\.test/);
    const edit = await authorApp.inject({
      method: 'PUT', url: '/padi.share.lab:unpublished',
      headers: { ...asAuthor(), 'if-match': `"${form!.content_hash}"` },
      payload: document('padi.share.lab', 'Edited after import'),
    });
    assert.equal(edit.statusCode, 200, 'own work stays editable');
  });

  test('shared copies leave the partner\'s Registry surface and the feed untouched', async () => {
    for (const url of ['/', '/profiles?limit=200', '/padi.share', '/padi.share/registration', '/padi', '/onuma']) {
      const ours = await partnerApp.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
      const canon = await upstreamApp.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
      assert.equal(ours.body, canon.body, `differs at ${url}`);
    }
    const journal = await partnerApp.inject({ method: 'GET', url: '/distribution/journal?since=0&limit=1000' });
    assert.ok(!journal.body.includes('test.share'), 'nothing about a shared test name is in the feed');
    assert.ok(!journal.body.includes('author.test'), 'nothing about sharing is in the feed');
  });

  test('the index: an Import pill and panel, Share on every row, shared copies said to be so', async () => {
    const page = await partnerApp.inject({ method: 'GET', url: '/workspace', headers: { accept: 'text/html' } });
    assert.match(page.body, /class="pill import"/);
    assert.match(page.body, /<details class="import" id="import">/);
    assert.match(page.body, /action="\/workspace\/import"/);
    assert.match(page.body, /shared copy · Padi, Inc\./);
    assert.ok(page.body.includes('href="/workspace/share/padi.share"'));
    assert.ok(page.body.includes(`data-copy="${PARTNER}/padi.share:unpublished"`), 'each row copies its Share link');
    const json = (await partnerApp.inject({ method: 'GET', url: '/workspace' })).json() as { forms: { name: string; held_as: string; shared?: { from: string; verified: boolean } }[] };
    const entry = json.forms.find((f) => f.name === 'padi.share.link')!;
    assert.equal(entry.held_as, 'shared copy');
    assert.deepEqual([entry.shared!.from, entry.shared!.verified], [AUTHOR, true]);
  });

  test('a released name\'s shared copy goes dark and is kept', async () => {
    await importOn(partnerApp, asPartner, { link: `${AUTHOR}/padi.share.gone:unpublished`, apply: true });
    const del = await upstreamApp.inject({ method: 'DELETE', url: '/padi.share.gone', headers: auth() });
    assert.equal(del.statusCode, 204, del.body);
    await sync(partnerDb.pool, fetchVia(upstreamApp));
    const gone = await partnerApp.inject({ method: 'GET', url: '/padi.share.gone:unpublished', headers: { accept: SPEC } });
    assert.equal(gone.statusCode, 404);
    const dark = await darkForms(partnerDb.pool, { orgs: [], test: true });
    assert.ok(dark.some((d) => d.name === 'padi.share.gone' && d.reason === 'not-registered'), JSON.stringify(dark));
    assert.ok(await getForm(partnerDb.pool, 'padi.share.gone'), 'kept, never deleted automatically');
    const shareGone = await partnerApp.inject({ method: 'GET', url: '/workspace/share/padi.share.gone' });
    assert.equal(shareGone.statusCode, 404, 'a dark form is not shared');
  });
});
