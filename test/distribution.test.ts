/**
 * Distribution and local instances — design §20, §20.1; spec §7.4, §9.3.
 *
 * Two real databases: the AUTHORITATIVE store, seeded and carrying the real
 * imported corpus plus the authoring routes so acts can be performed on it,
 * and an INSTANCE, empty, that bootstraps from the first's snapshot and
 * follows its journal through app.inject() standing in for fetch().
 *
 * The questions worth asking:
 *   - does the TypeScript chain function agree with the trigger, event for
 *     event, over the real log — or is the journal unverifiable by anyone
 *     but the database that wrote it?
 *   - after bootstrap and after every kind of act, does the instance answer
 *     BYTE-IDENTICALLY to the authoritative host (§20.4)?
 *   - does a tampered or gapped page move the cursor? (It must not.)
 *   - can anything be written to an instance? (No.)
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
import { verify as verifyChain, head as chainHeadOf } from '../src/audit.ts';
import {
  JOURNAL_FORMAT,
  verifyPage,
  verifySnapshot,
  type JournalEntry,
  type JournalPage,
  type PublicEntry,
  type Snapshot,
} from '../src/distribution/journal.ts';
import { bootstrap, sync, type Fetch } from '../src/distribution/follower.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')));

const OPERATOR: Credential = {
  token: 'operator-'.padEnd(40, 'o'),
  userId: '',
  kind: 'agent',
  principal: 'anto@padi.io',
  scopes: ['draft:write', 'publish', 'deprecate', 'operator'],
};
const auth = () => ({ authorization: `Bearer ${OPERATOR.token}` });

const SPEC = 'application/cp+json; profile=2026';
const UPSTREAM = 'http://upstream.test';

let authoritative: Harness;
let instance: Harness;
let upstreamApp: FastifyInstance;
let instanceApp: FastifyInstance;

/** fetch() over app.inject(): the follower never knows the difference. */
function fetchVia(app: FastifyInstance, tamper?: (url: string, body: unknown) => unknown): Fetch {
  return async (url) => {
    const path = url.startsWith(UPSTREAM) ? url.slice(UPSTREAM.length) : url;
    const response = await app.inject({ method: 'GET', url: path });
    let body: unknown = response.json();
    if (tamper) body = tamper(path, body);
    return { status: response.statusCode, json: async () => body };
  };
}

function document(name: string, properties: Record<string, unknown>[], title = 'Fed through the journal') {
  return {
    Header: {
      Name: name,
      Owner: 'Padi, Inc.',
      Title: title,
      Provider: 'Sensor',
      Consumer: 'Display',
      Description: 'Published on the authoritative store; expected on the instance.',
      Website: 'https://padi.io/feed',
    },
    Properties: { Provider: properties, Consumer: [] },
  };
}
const p1 = { Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' };
const p2 = { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' };

before(async () => {
  authoritative = await freshDatabase();
  instance = await freshDatabase();

  const client = await authoritative.pool.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    await runImport(client, corpus, planImport(corpus));
    const user = await client.query<{ id: string }>(
      `INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|operator', 'anto@padi.io') RETURNING id`,
    );
    OPERATOR.userId = user.rows[0]!.id;
    await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [seeded.orgId, OPERATOR.userId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  upstreamApp = Fastify();
  await registerAuthoringRoutes(upstreamApp, {
    pool: authoritative.pool,
    ownership: new PgOwnershipStore(authoritative.pool),
    credentials: [OPERATOR],
  });
  await registerResolutionRoutes(upstreamApp, { db: authoritative.pool });
  await upstreamApp.ready();

  instanceApp = Fastify();
  await registerResolutionRoutes(instanceApp, { db: instance.pool, role: 'instance', upstream: UPSTREAM });
  registerInstanceRefusals(instanceApp, UPSTREAM);
  await instanceApp.ready();
});

after(async () => {
  await upstreamApp.close();
  await instanceApp.close();
  await authoritative.close();
  await instance.close();
});

async function allEntries(app: FastifyInstance, limit = 50): Promise<{ entries: JournalEntry[]; pages: JournalPage[] }> {
  const entries: JournalEntry[] = [];
  const pages: JournalPage[] = [];
  let since = 0;
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/distribution/journal?since=${since}&limit=${limit}` });
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json() as JournalPage;
    pages.push(page);
    entries.push(...page.entries);
    if (!page.more) break;
    since = page.next;
  }
  return { entries, pages };
}

/** Every resolution answer that matters, from one host, as comparable text. */
async function resolutionSurface(app: FastifyInstance): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const index = await app.inject({ method: 'GET', url: '/', headers: { accept: 'application/json' } });
  out.set('/', index.body);
  const catalog = await app.inject({ method: 'GET', url: '/profiles?limit=200', headers: { accept: 'application/json' } });
  out.set('/profiles', catalog.body);

  for (const a of (index.json() as { allocations: { tlp: string }[] }).allocations) {
    if (a.tlp === 'health') continue; // withheld as a path (§3.2); /health is the liveness route and names its role
    const page = await app.inject({ method: 'GET', url: `/${a.tlp}`, headers: { accept: 'application/json' } });
    out.set(`/${a.tlp}`, page.body);
  }
  for (const e of (catalog.json() as { entries: { name: string; versions: { version: number }[] }[] }).entries) {
    const selection = await app.inject({ method: 'GET', url: `/${e.name}`, headers: { accept: SPEC } });
    out.set(`/${e.name}`, selection.body);
    const registration = await app.inject({ method: 'GET', url: `/${e.name}/registration` });
    out.set(`/${e.name}/registration`, registration.body);
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

describe('the snapshot (§20.1)', () => {
  test('is the whole published corpus, at the audit head, and every document hashes', async () => {
    const response = await upstreamApp.inject({ method: 'GET', url: '/distribution/snapshot' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-cache');
    const snap = response.json() as Snapshot;

    assert.equal(snap.journal_format, JOURNAL_FORMAT);
    const head = await chainHeadOf(authoritative.pool);
    assert.equal(snap.head.seq, Number(head!.seq));
    assert.equal(snap.head.event_hash, head!.event_hash);

    const counts = await authoritative.pool.query<{ names: string; versions: string; allocations: string }>(
      `SELECT (SELECT count(*) FROM profile WHERE discarded_at IS NULL)::text AS names,
              (SELECT count(*) FROM profile_version)::text AS versions,
              (SELECT count(*) FROM allocation)::text AS allocations`,
    );
    assert.equal(snap.names.length, Number(counts.rows[0]!.names));
    assert.equal(snap.versions.length, Number(counts.rows[0]!.versions));
    assert.equal(snap.allocations.length, Number(counts.rows[0]!.allocations));
    assert.ok(snap.versions.length >= 69, `expected the imported corpus, got ${snap.versions.length} versions`);
    assert.deepEqual(verifySnapshot(snap), []);
  });

  test('carries stable public facts about allocations and nothing else (§19.3)', async () => {
    const snap = (await upstreamApp.inject({ method: 'GET', url: '/distribution/snapshot' })).json() as Snapshot;
    for (const a of snap.allocations) {
      assert.deepEqual(Object.keys(a).sort(), ['grandfathered', 'holder', 'id', 'org_id', 'tlp']);
    }
  });
});

describe('the journal (§20.1)', () => {
  test('is the audit chain, contiguous from genesis, and the TypeScript verifier agrees with the trigger on every event', async () => {
    assert.equal(await verifyChain(authoritative.pool), null, 'the database itself must find the chain intact');
    const { entries } = await allEntries(upstreamApp);
    const head = await chainHeadOf(authoritative.pool);
    assert.equal(entries.length, Number(head!.seq));

    const { failures, head: last } = verifyPage(entries, { seq: 0, event_hash: null });
    assert.deepEqual(failures, []);
    assert.equal(last!.event_hash, head!.event_hash);
  });

  test('public acts carry a hashed subject; the rest are redacted links', async () => {
    const { entries } = await allEntries(upstreamApp);
    const publics = entries.filter((e): e is PublicEntry => e.public);
    const redacted = entries.filter((e) => !e.public);

    assert.ok(redacted.some((e) => e.action === 'organization.create'), 'the operator organization is not a public act');
    assert.ok(redacted.some((e) => e.action === 'allocation.grandfather'), 'the bootstrap rulings are not a public act');
    for (const e of redacted) {
      assert.deepEqual(Object.keys(e).sort(), ['action', 'event_hash', 'prev_event_hash', 'public', 'seq']);
    }

    const registers = publics.filter((e) => e.action === 'profile.register');
    const publishes = publics.filter((e) => e.action === 'profile.publish');
    assert.ok(registers.length >= 69 && publishes.length >= 69);
    for (const e of [...registers, ...publishes]) {
      assert.equal(e.subject_source, 'stored', `seq ${e.seq}: written after migration 7, so the payload is stored`);
      assert.ok(e.ref?.name);
    }
    for (const e of publishes) {
      assert.ok(e.document !== undefined, `seq ${e.seq}: a publication carries its document`);
      assert.equal(typeof (e.subject as { published_at?: unknown }).published_at, 'string', 'published_at is inside the hashed payload');
    }
    for (const e of registers) {
      assert.equal(typeof (e.subject as { registered_at?: unknown }).registered_at, 'string', 'registered_at is inside the hashed payload');
    }
  });

  test('pages: a full page is immutable and carries no head; the last page is no-cache and does', async () => {
    const { pages } = await allEntries(upstreamApp, 40);
    assert.ok(pages.length >= 3);
    for (const [i, page] of pages.entries()) {
      const last = i === pages.length - 1;
      assert.equal(page.more, !last);
      assert.equal(page.head === undefined, !last, `page ${i}`);
      assert.equal(page.entries.length <= 40, true);
    }
    const full = await upstreamApp.inject({ method: 'GET', url: '/distribution/journal?since=0&limit=40' });
    assert.equal(full.headers['cache-control'], 'public, max-age=31536000, immutable');
    const tail = await upstreamApp.inject({ method: 'GET', url: `/distribution/journal?since=${pages.at(-1)!.since}&limit=40` });
    assert.equal(tail.headers['cache-control'], 'no-cache');
    // Resuming from `next` of one page yields the very next seq.
    for (let i = 1; i < pages.length; i++) {
      assert.equal(pages[i]!.entries[0]!.seq, pages[i - 1]!.next + 1);
    }
  });

  test('rejects malformed cursors', async () => {
    for (const q of ['since=-1', 'since=abc', 'limit=0', 'limit=5000']) {
      const r = await upstreamApp.inject({ method: 'GET', url: `/distribution/journal?${q}` });
      assert.equal(r.statusCode, 400, q);
    }
  });

  test('the status of the authoritative host names its head and no anchor yet', async () => {
    const r = await upstreamApp.inject({ method: 'GET', url: '/distribution/status' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.role, 'authoritative');
    assert.equal(body.anchor, null);
    assert.equal(body.head.seq, Number((await chainHeadOf(authoritative.pool))!.seq));
  });
});

describe('the instance (§20, spec §7.4)', () => {
  test('before bootstrap it answers nothing and says so', async () => {
    const status = await instanceApp.inject({ method: 'GET', url: '/distribution/status' });
    assert.equal(status.json().bootstrapped, false);
    assert.equal(status.json().role, 'instance');
    const miss = await instanceApp.inject({ method: 'GET', url: '/padi.tstat.basic', headers: { accept: SPEC } });
    assert.equal(miss.statusCode, 404);
  });

  test('bootstraps from the snapshot and then answers BYTE-IDENTICALLY (§20.4)', async () => {
    const result = await bootstrap(instance.pool, UPSTREAM, fetchVia(upstreamApp));
    assert.equal(result.bootstrapped, true);
    const again = await bootstrap(instance.pool, UPSTREAM, fetchVia(upstreamApp));
    assert.equal(again.bootstrapped, false, 'a second bootstrap is a no-op');

    assertSameSurface(await resolutionSurface(upstreamApp), await resolutionSurface(instanceApp));

    const status = (await instanceApp.inject({ method: 'GET', url: '/distribution/status' })).json();
    assert.equal(status.bootstrapped, true);
    assert.equal(status.upstream, UPSTREAM);
    assert.equal(status.cursor.seq, result.head!.seq);
    assert.equal(status.behind, 0);
  });

  test('the instance wrote no audit events of its own', async () => {
    const { rows } = await instance.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_event`);
    assert.equal(rows[0]!.n, '0');
  });

  test('with nothing new, sync applies nothing and the cursor stays', async () => {
    const before = (await instanceApp.inject({ method: 'GET', url: '/distribution/status' })).json();
    const result = await sync(instance.pool, fetchVia(upstreamApp));
    assert.equal(result.applied, 0);
    assert.equal(result.cursor.seq, before.cursor.seq);
  });

  test('follows every kind of public act and stays byte-identical', async () => {
    // Register, publish twice, deprecate v1, change stewardship, register and
    // release another name, allocate a new Prefix — one of each (§20.2).
    const put = await upstreamApp.inject({ method: 'PUT', url: '/padi.fed', headers: auth() });
    assert.equal(put.statusCode, 201, put.body);
    const pub1 = await upstreamApp.inject({ method: 'POST', url: '/padi.fed/publish', headers: auth(), payload: document('padi.fed', [p1]) });
    assert.equal(pub1.statusCode, 201, pub1.body);
    const pub2 = await upstreamApp.inject({ method: 'POST', url: '/padi.fed/publish', headers: auth(), payload: document('padi.fed', [p1, p2], 'Grown by one property') });
    assert.equal(pub2.statusCode, 201, pub2.body);
    const dep = await upstreamApp.inject({ method: 'POST', url: '/padi.fed:1/deprecate', headers: auth() });
    assert.equal(dep.statusCode, 200, dep.body);
    const steward = await upstreamApp.inject({ method: 'PATCH', url: '/padi.fed:2/header', headers: auth(), payload: { Owner: 'Padi, Inc. (stewardship moved)', Website: 'https://padi.io/fed-2' } });
    assert.equal(steward.statusCode, 200, steward.body);
    const put2 = await upstreamApp.inject({ method: 'PUT', url: '/padi.fed-released', headers: auth() });
    assert.equal(put2.statusCode, 201, put2.body);
    const del = await upstreamApp.inject({ method: 'DELETE', url: '/padi.fed-released', headers: auth() });
    assert.equal(del.statusCode, 204, del.body);
    const alloc = await upstreamApp.inject({
      method: 'POST', url: '/operator/allocations', headers: auth(),
      payload: { tlp: 'fedco', organization: { name: 'Fed Co.' }, evidence: 'test ruling: the operator verified the claimant controls fedco.example' },
    });
    assert.equal(alloc.statusCode, 201, alloc.body);
    assert.equal(await verifyChain(authoritative.pool), null);

    const result = await sync(instance.pool, fetchVia(upstreamApp), 3); // small pages, several transactions
    assert.ok(result.pages >= 2, 'the acts should span more than one page at limit=3');
    assert.ok(result.applied >= 7);

    assertSameSurface(await resolutionSurface(upstreamApp), await resolutionSurface(instanceApp));

    // And the specifics, so a byte-identical failure elsewhere does not hide them.
    const v1 = await instanceApp.inject({ method: 'GET', url: '/padi.fed:1', headers: { accept: SPEC } });
    assert.equal(v1.headers['x-cp-status'], 'deprecated');
    const released = await instanceApp.inject({ method: 'GET', url: '/padi.fed-released', headers: { accept: SPEC } });
    assert.equal(released.statusCode, 404);
    const fedco = await instanceApp.inject({ method: 'GET', url: '/fedco', headers: { accept: 'application/json' } });
    assert.equal(fedco.statusCode, 200);
    assert.equal(fedco.json().holder, 'Fed Co.');
    const steward2 = await instance.pool.query<{ header_owner: string; header_website: string }>(
      `SELECT header_owner, header_website FROM profile_version v JOIN profile p ON p.id = v.profile_id WHERE p.name = 'padi.fed' AND v.version = 2`,
    );
    assert.deepEqual(steward2.rows[0], { header_owner: 'Padi, Inc. (stewardship moved)', header_website: 'https://padi.io/fed-2' });

    const status = (await instanceApp.inject({ method: 'GET', url: '/distribution/status' })).json();
    assert.equal(status.cursor.seq, Number((await chainHeadOf(authoritative.pool))!.seq));
    assert.equal(status.last_error, null);
  });

  test('re-serves the journal it verified, and refuses to answer for what it never held', async () => {
    const upstreamHead = (await upstreamApp.inject({ method: 'GET', url: '/distribution/status' })).json().head;
    const state = await instance.pool.query<{ bootstrapped: string }>(`SELECT min(seq)::text AS bootstrapped FROM journal_entry`);
    const firstHeld = Number(state.rows[0]!.bootstrapped);

    const mine = await instanceApp.inject({ method: 'GET', url: `/distribution/journal?since=${firstHeld - 1}&limit=1000` });
    assert.equal(mine.statusCode, 200, mine.body);
    const theirs = await upstreamApp.inject({ method: 'GET', url: `/distribution/journal?since=${firstHeld - 1}&limit=1000` });
    assert.deepEqual(mine.json().entries, theirs.json().entries, 'the copy is verbatim');
    assert.deepEqual(mine.json().head, upstreamHead);

    const tooEarly = await instanceApp.inject({ method: 'GET', url: '/distribution/journal?since=0' });
    assert.equal(tooEarly.statusCode, 416);
    assert.equal(tooEarly.json().authoritative, UPSTREAM);
  });

  test('a tampered entry does not move the cursor, and the failure is reported', async () => {
    // One more act upstream, then serve it with its rationale altered: the
    // preimage no longer hashes to event_hash.
    const put = await upstreamApp.inject({ method: 'PUT', url: '/padi.fed-tamper', headers: auth() });
    assert.equal(put.statusCode, 201);
    const before = (await instanceApp.inject({ method: 'GET', url: '/distribution/status' })).json();

    const tampering = fetchVia(upstreamApp, (path, body) => {
      if (!path.startsWith('/distribution/journal')) return body;
      const page = body as JournalPage;
      for (const e of page.entries) if (e.public && e.action === 'profile.register') e.rationale = 'a quiet edit';
      return page;
    });
    await assert.rejects(sync(instance.pool, tampering), (error: Error & { failures?: { reason: string }[] }) => {
      assert.ok(error.failures?.some((f) => f.reason === 'event-hash-mismatch'), JSON.stringify(error.failures));
      return true;
    });

    const after = (await instanceApp.inject({ method: 'GET', url: '/distribution/status' })).json();
    assert.equal(after.cursor.seq, before.cursor.seq, 'the cursor must not move past a break');
    assert.match(after.last_error, /failed verification/);
    const held = await instanceApp.inject({ method: 'GET', url: '/padi.fed-tamper/registration' });
    assert.equal(held.statusCode, 404, 'nothing from the bad page was applied');

    // A gap in the chain is refused the same way: two acts pending, the
    // first dropped from the page.
    const put2 = await upstreamApp.inject({ method: 'PUT', url: '/padi.fed-gap', headers: auth() });
    assert.equal(put2.statusCode, 201);
    const gapping = fetchVia(upstreamApp, (path, body) => {
      if (!path.startsWith('/distribution/journal')) return body;
      const page = body as JournalPage;
      page.entries = page.entries.slice(1);
      return page;
    });
    await assert.rejects(sync(instance.pool, gapping), (error: Error & { failures?: { reason: string }[] }) => {
      assert.ok(error.failures?.some((f) => f.reason === 'not-contiguous' || f.reason === 'link-broken'));
      return true;
    });

    // Then the honest page lands and clears the error.
    const result = await sync(instance.pool, fetchVia(upstreamApp));
    assert.equal(result.applied, 2);
    const fixed = (await instanceApp.inject({ method: 'GET', url: '/distribution/status' })).json();
    assert.equal(fixed.last_error, null);
    assert.equal((await instanceApp.inject({ method: 'GET', url: '/padi.fed-tamper/registration' })).statusCode, 200);
  });

  test('a document that does not hash to what its act recorded is refused', async () => {
    const put = await upstreamApp.inject({ method: 'PUT', url: '/padi.fed-doc', headers: auth() });
    assert.equal(put.statusCode, 201);
    const pub = await upstreamApp.inject({ method: 'POST', url: '/padi.fed-doc/publish', headers: auth(), payload: document('padi.fed-doc', [p1]) });
    assert.equal(pub.statusCode, 201, pub.body);

    const swapping = fetchVia(upstreamApp, (path, body) => {
      if (!path.startsWith('/distribution/journal')) return body;
      const page = body as JournalPage;
      for (const e of page.entries) {
        if (e.public && e.action === 'profile.publish' && e.ref?.name === 'padi.fed-doc') {
          (e.document as { Header: { Title: string } }).Header.Title = 'Not what was published';
        }
      }
      return page;
    });
    await assert.rejects(sync(instance.pool, swapping), (error: Error & { failures?: { reason: string }[] }) => {
      assert.ok(error.failures?.some((f) => f.reason === 'document-hash-mismatch'), JSON.stringify(error.failures));
      return true;
    });
    assert.equal((await instanceApp.inject({ method: 'GET', url: '/padi.fed-doc:1', headers: { accept: SPEC } })).statusCode, 404);

    await sync(instance.pool, fetchVia(upstreamApp));
    assertSameSurface(await resolutionSurface(upstreamApp), await resolutionSurface(instanceApp));
  });

  test('accepts no writes: every non-GET names the authoritative host (§4.4)', async () => {
    for (const [method, url] of [
      ['PUT', '/padi.instance-write'],
      ['POST', '/padi.fed/publish'],
      ['POST', '/padi.fed:2/deprecate'],
      ['PATCH', '/padi.fed:2/header'],
      ['DELETE', '/padi.fed'],
      ['POST', '/operator/allocations'],
      ['POST', '/'],
    ] as const) {
      const r = await instanceApp.inject({ method, url, headers: auth(), payload: {} });
      assert.equal(r.statusCode, 405, `${method} ${url}: ${r.body}`);
      assert.equal(r.json().authoritative, UPSTREAM);
    }
  });
});
