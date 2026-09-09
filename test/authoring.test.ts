/**
 * The authoring lifecycle — design §13, §15; §23 priorities 2 and 7.
 *
 * Reworked for the 8 September 2026 revision: the Registry holds no
 * unpublished content (spec §7.3), so publication CARRIES its content — the
 * document travels in the POST body, is checked, and is frozen or refused
 * with nothing retained. The author's workspace is the author's own; here it
 * is a local variable, which is exactly the point.
 *
 * The scope-containment block is §23 priority 7: "a draft:write credential
 * cannot publish or deprecate under any endpoint or parameter combination;
 * and dry_run=true provably writes nothing."
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { registerAuthoringRoutes, type Credential } from '../src/part-two/routes.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { checkAdditivity } from '../src/profile/additivity.ts';
import { verify } from '../src/audit.ts';

const DRAFTER: Credential = {
  token: 'drafter-'.padEnd(40, 'x'),
  userId: '', // filled in before()
  kind: 'agent',
  principal: 'anto@padi.io',
  scopes: ['draft:write'],
};
const PUBLISHER: Credential = {
  token: 'publisher-'.padEnd(40, 'y'),
  userId: '',
  kind: 'human',
  scopes: ['draft:write', 'publish', 'deprecate'],
};

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;

const auth = (credential: Credential) => ({ authorization: `Bearer ${credential.token}` });

/** The author's working document — held HERE, not in the Registry (§7.3). */
function workingDocument(properties: Record<string, unknown>[], channels?: Record<string, unknown>[]) {
  return {
    Header: {
      'Name': 'padi.authored',
      'Owner': 'Padi, Inc.',
      'Title': 'Authored end to end',
      'Provider': 'Sensor',
      'Consumer': 'Display',
      'Description': 'Written through the authoring API by an agent.',
      'Website': 'https://padi.io/authored',
    },
    Properties: { Provider: properties, Consumer: [] },
    ...(channels ? { Channels: channels } : {}),
  };
}

const propertyV1 = { Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' };
const propertyV2 = { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' };

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    const user = await client.query<{ id: string }>(
      `INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|author', 'anto@padi.io') RETURNING id`,
    );
    await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      seeded.orgId,
      user.rows[0]!.id,
    ]);
    DRAFTER.userId = user.rows[0]!.id;
    PUBLISHER.userId = user.rows[0]!.id;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  app = Fastify();
  await registerAuthoringRoutes(app, {
    pool: db,
    ownership: new PgOwnershipStore(db),
    credentials: [DRAFTER, PUBLISHER],
  });
  await registerResolutionRoutes(app, { db, html: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

describe('the lifecycle, end to end (§13)', () => {
  test('PUT /<name> registers — the name, and nothing else (spec §6.3)', async () => {
    const response = await app.inject({ method: 'PUT', url: '/padi.authored', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 201);
  });

  test('registration is idempotent on the name', async () => {
    const response = await app.inject({ method: 'PUT', url: '/padi.authored', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().existing, true);
  });

  test('registering under an unallocated Prefix is a structured 403', async () => {
    const foreign = await app.inject({ method: 'PUT', url: '/nowhere.mine', headers: auth(DRAFTER) });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.json().code, 'authorization.allocation-not-found');
  });

  test('the registered name holds NOTHING — no content column exists to hold it (spec §7.3)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'profile'`,
    );
    const columns = rows.map((r) => r.column_name);
    for (const gone of ['draft_content', 'draft_modified', 'draft_disclosure']) {
      assert.ok(!columns.includes(gone), `${gone} still exists; the Registry may not hold unpublished content`);
    }
  });

  test('publish without a payload is a structured 400 naming the reason', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'publish.payload_required');
    assert.match(response.json().message, /holds no unpublished content/);
  });

  test('dry_run rehearses every gate on the payload and reports what would happen', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish?dry_run=true', headers: auth(PUBLISHER),
      payload: workingDocument([propertyV1]),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().publishable, true);
    assert.equal(response.json().would_assign_version, 1);
  });

  test('publication freezes the payload as version 1', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([propertyV1]),
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().version, 1);

    // And it resolves immediately, on the same host, by GET.
    const resolved = await app.inject({ method: 'GET', url: '/padi.authored:1' });
    assert.equal(resolved.statusCode, 200);
    assert.equal(JSON.parse(resolved.body).Header.Name, 'padi.authored');
  });

  test('an additive document publishes as version 2', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([propertyV1, propertyV2]),
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().version, 2);
  });

  test('deprecation excludes from selection and nothing else', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored:1/deprecate', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 200);

    const still = await app.inject({ method: 'GET', url: '/padi.authored:1' });
    assert.equal(still.statusCode, 200, 'a deprecated version still resolves');
    assert.equal(still.headers['x-cp-status'], 'deprecated');
  });

  test('PATCH :n/header accepts Owner and Website, and nothing else', async () => {
    const ok = await app.inject({
      method: 'PATCH', url: '/padi.authored:2/header', headers: auth(PUBLISHER),
      payload: { Owner: 'Padi, Inc. (successor)' },
    });
    assert.equal(ok.statusCode, 200);

    const refused = await app.inject({
      method: 'PATCH', url: '/padi.authored:2/header', headers: auth(PUBLISHER),
      payload: { Title: 'A new title' },
    });
    assert.equal(refused.statusCode, 422);
    assert.equal(refused.json().code, 'header.fixed_by_publication');
  });
});

describe('the Registry holds no unpublished content (spec §7.3, §9.3)', () => {
  test('PUT /<name>:unpublished is refused with the architecture, not a permission error', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/padi.authored:unpublished', headers: auth(DRAFTER),
      payload: workingDocument([propertyV1]),
    });
    assert.equal(response.statusCode, 405);
    assert.equal(response.json().code, 'unpublished.not_held');
    assert.match(response.json().message, /lives with you/);
  });

  test('GET /<name>:unpublished is never resolved — for anyone', async () => {
    const response = await app.inject({ method: 'GET', url: '/padi.authored:unpublished' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().resolvable, false);
    assert.match(response.json().note, /never resolved by the Registry/);
  });

  test('a refused publication retains NOTHING (§7.3)', async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM profile_version`);

    // Non-additive: drops both properties.
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([{ Name: 'other', Mandatory: 'no', Propagate: 'no', Description: 'd' }]),
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().message, /nothing was retained/);

    const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM profile_version`);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });
});

describe('the additivity gate (§23 priority 2, spec §6.2)', () => {
  test('removing a Property is refused with a structured, actionable finding', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([]), // reading and units both gone — and zero Properties besides
    });
    assert.equal(response.statusCode, 422);
    const findings = response.json().findings;
    const removed = findings.filter((f: { code: string }) => f.code === 'additivity.property_removed');
    assert.equal(removed.length, 2);
    assert.equal(removed[0].gate, 'additivity');
    assert.ok(findings.some((f: { code: string }) => f.code === 'properties.none'),
      'zero Properties is its own finding (§6.4)');
    // No successor name is proposed (spec §7.7).
    assert.ok(!JSON.stringify(findings).includes('suggest'));
  });

  test('redefining a flag is refused, naming the attribute and both values', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([{ ...propertyV1, Propagate: 'no' }, propertyV2]),
    });
    assert.equal(response.statusCode, 422);
    const finding = response.json().findings.find(
      (f: { code: string }) => f.code === 'additivity.property_redefined',
    );
    assert.equal(finding.attribute, 'propagate');
    assert.equal(finding.was, true);
    assert.equal(finding.now, false);
  });

  test('adding a Default where none was is a redefinition (8 Sept §6.2)', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([{ ...propertyV1, Default: '0' }, propertyV2]),
    });
    assert.equal(response.statusCode, 422);
    const finding = response.json().findings.find(
      (f: { code: string; attribute?: string }) => f.code === 'additivity.property_redefined',
    );
    assert.equal(finding.attribute, 'default');
    assert.equal(finding.was, '(absent)');
    assert.equal(finding.now, '0');
  });

  test('adding a MANDATORY Property is refused (spec §6.2)', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument([
        propertyV1, propertyV2,
        { Name: 'calibration', Mandatory: 'yes', Propagate: 'no', Description: 'New and required.' },
      ]),
    });
    assert.equal(response.statusCode, 422);
    const finding = response.json().findings.find(
      (f: { code: string }) => f.code === 'additivity.added_property_not_optional',
    );
    assert.equal(finding.property, 'calibration');
  });

  test('ADDING A CHANNEL to a Channel-free Profile is refused — Channels are fixed at v1 (§6.2)', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
      payload: workingDocument(
        [propertyV1, propertyV2],
        [{ Name: 'feed', Mode: 'stream', Protocol: 'http', Description: 'A late-added channel.' }],
      ),
    });
    assert.equal(response.statusCode, 422);
    const finding = response.json().findings.find(
      (f: { code: string }) => f.code === 'additivity.channel_added',
    );
    assert.equal(finding.channel, 'feed');
    assert.match(finding.message, /indistinguishable from a broken one/);
  });

  test('documentary changes block nothing — §6.4 takes no view of them', () => {
    const before = { properties: [{ name: 'x', description: 'old', role: 'provider' as const, mandatory: true, propagate: true }] };
    const after = { properties: [{ name: 'x', description: 'NEW WORDING', role: 'provider' as const, mandatory: true, propagate: true, sample: '5' }] };
    const result = checkAdditivity(after, before, 1);
    assert.equal(result.additive, true);
    assert.equal(result.documentaryChanges.length, 2);
  });

  test('channel additivity unit cases: remove and redefine', () => {
    const channel = { name: 'c', mode: 'stream' as const, protocol: 'http', description: 'd' };
    const v1 = { properties: [{ name: 'x', description: 'd', role: 'provider' as const, mandatory: true, propagate: false }], channels: [channel] };

    const removed = checkAdditivity({ ...v1, channels: [] }, v1, 1);
    assert.ok(removed.findings.some((f) => f.code === 'additivity.channel_removed'));

    const redefined = checkAdditivity(
      { ...v1, channels: [{ ...channel, mode: 'message' as const }] }, v1, 1);
    assert.ok(redefined.findings.some((f) => f.code === 'additivity.channel_redefined'));

    const unchanged = checkAdditivity(v1, v1, 1);
    assert.equal(unchanged.additive, true);
  });

  test('a rejected publication changes nothing — the version count is untouched', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile_version v JOIN profile p ON p.id = v.profile_id
        WHERE p.name = 'padi.authored'`,
    );
    assert.equal(rows[0]!.n, '2');
  });
});

describe('SCOPE CONTAINMENT — §23 priority 7', () => {
  test('draft:write cannot publish — not even as a dry run, not even with a perfect payload', async () => {
    for (const url of [
      '/padi.authored/publish',
      '/padi.authored/publish?dry_run=true',
      '/padi.authored/publish?dry_run=false',
    ]) {
      const response = await app.inject({
        method: 'POST', url, headers: auth(DRAFTER),
        payload: workingDocument([propertyV1, propertyV2]),
      });
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().code, 'auth.scope', url);
      assert.equal(response.json().required_scope, 'publish', url);
    }
  });

  test('draft:write cannot deprecate', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored:2/deprecate', headers: auth(DRAFTER),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().required_scope, 'deprecate');
  });

  test('no token at all is a 401 on every write verb', async () => {
    const attempts: [string, string][] = [
      ['PUT', '/padi.someother'],
      ['POST', '/padi.authored/publish'],
      ['POST', '/padi.authored:2/deprecate'],
      ['PATCH', '/padi.authored:2/header'],
      ['DELETE', '/padi.authored'],
    ];
    for (const [method, url] of attempts) {
      const response = await app.inject({ method: method as never, url, payload: {} });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }
  });

  test('dry_run=true provably writes nothing', async () => {
    const snapshot = async () =>
      (
        await db.query<{ versions: string; head: string | null; profiles: string }>(
          `SELECT
             (SELECT count(*)::text FROM profile_version) AS versions,
             (SELECT max(event_hash) FROM (SELECT event_hash FROM audit_event ORDER BY seq DESC LIMIT 1) h) AS head,
             (SELECT count(*)::text FROM profile) AS profiles`,
        )
      ).rows[0]!;

    const before = await snapshot();
    const rehearsal = await app.inject({
      method: 'POST', url: '/padi.authored/publish?dry_run=true', headers: auth(PUBLISHER),
      payload: workingDocument([propertyV1, propertyV2,
        { Name: 'zone', Mandatory: 'no', Propagate: 'no', Description: 'Optional zone.' }]),
    });
    const after = await snapshot();

    assert.equal(rehearsal.statusCode, 200);
    assert.equal(rehearsal.json().dry_run, true);
    assert.equal(rehearsal.json().would_assign_version, 3);
    assert.deepEqual(after, before, 'dry_run left a trace');
  });
});

describe('release (§13.5, spec §7.3)', () => {
  test('a never-published name may be released', async () => {
    await app.inject({ method: 'PUT', url: '/padi.scratch', headers: auth(DRAFTER) });
    const response = await app.inject({ method: 'DELETE', url: '/padi.scratch', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 204);

    const gone = await app.inject({ method: 'GET', url: '/padi.scratch' });
    assert.equal(gone.statusCode, 404);
  });

  test('a published name is permanent — release is a structured 409', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/padi.authored', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'immutability.name_permanent');
  });

  test('DELETE on a version is refused outright', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/padi.authored:1', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 405);
  });
});

describe('the chain survives the whole session', () => {
  test('every authored act is in one unbroken audit chain', async () => {
    assert.equal(await verify(db), null);
    const { rows } = await db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_event ORDER BY action`,
    );
    const actions = rows.map((r) => r.action);
    for (const expected of [
      'profile.register', 'profile.publish', 'profile.deprecate', 'profile.stewardship', 'profile.discard',
    ]) {
      assert.ok(actions.includes(expected), `no audit event for ${expected}`);
    }
    // And none of the acts the 8 Sept revision removed from the Registry.
    assert.ok(!actions.includes('profile.draft'), 'the Registry recorded holding a draft');
    assert.ok(!actions.includes('profile.disclose'), 'the Registry recorded a disclosure act');
  });
});
