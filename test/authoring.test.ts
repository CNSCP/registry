/**
 * The authoring lifecycle — design §13, §15; §23 priorities 2, 5 and 7.
 *
 * Runs the whole intended Phase 0 path: an agent registers a name, shapes the
 * Draft, rehearses publication with dry_run, publishes, reshapes, is refused
 * for a non-additive change, and deprecates — against a real database, through
 * the real routes.
 *
 * The scope-containment block is §23 priority 7 verbatim: "a draft:write
 * credential cannot publish, deprecate, or disclose, under any endpoint or
 * parameter combination; and dry_run=true provably writes nothing."
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
  scopes: ['draft:write', 'publish', 'deprecate', 'disclose'],
};

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;

const auth = (credential: Credential) => ({ authorization: `Bearer ${credential.token}` });

function draftDocument(properties: Record<string, unknown>[]) {
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
  };
}

const propertyV1 = { Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' };

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
  // Authoring and resolution share the host and split by method (§15).
  await registerAuthoringRoutes(app, {
    pool: db,
    ownership: new PgOwnershipStore(db),
    credentials: [DRAFTER, PUBLISHER],
    operatedRealms: ['padi-dev-realm'],
  });
  await registerResolutionRoutes(app, { db, html: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await harness.close();
});

describe('the lifecycle, end to end (§13)', () => {
  test('PUT /<name> registers and creates the Draft', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/padi.authored', headers: auth(DRAFTER),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().draft, '/padi.authored:draft');
  });

  test('registration is idempotent on the name', async () => {
    const response = await app.inject({ method: 'PUT', url: '/padi.authored', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().existing, true);
  });

  test('registering under a Prefix you do not hold is a structured 403', async () => {
    const response = await app.inject({ method: 'PUT', url: '/c4sb.mine', headers: auth(DRAFTER) });
    // c4sb is operator-held pending its claimant; the author IS an operator
    // member, so pick a truly foreign case: an unallocated Prefix.
    const foreign = await app.inject({ method: 'PUT', url: '/nowhere.mine', headers: auth(DRAFTER) });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.json().code, 'authorization.allocation-not-found');
    assert.equal(foreign.json().gate, 'authorization');
    void response;
  });

  test('PUT :draft replaces the Draft, without restriction and without gates', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/padi.authored:draft', headers: auth(DRAFTER),
      payload: draftDocument([propertyV1]),
    });
    assert.equal(response.statusCode, 200);
  });

  test('dry_run rehearses every gate and reports what would happen', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish?dry_run=true', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().publishable, true);
    assert.equal(response.json().would_assign_version, 1);
  });

  test('publication freezes the Draft as version 1', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().version, 1);

    // And it resolves immediately, on the same host, by GET.
    const resolved = await app.inject({ method: 'GET', url: '/padi.authored:1' });
    assert.equal(resolved.statusCode, 200);
    assert.equal(JSON.parse(resolved.body).Header.Name, 'padi.authored');
  });

  test('the Draft persists after publication as the workspace (spec §6.2)', async () => {
    const { rows } = await db.query<{ draft_content: unknown }>(
      `SELECT draft_content FROM profile WHERE name = 'padi.authored'`,
    );
    assert.ok(rows[0]!.draft_content, 'publication must not consume the Draft');
  });

  test('an additive Draft publishes as version 2', async () => {
    await app.inject({
      method: 'PUT', url: '/padi.authored:draft', headers: auth(DRAFTER),
      payload: draftDocument([
        propertyV1,
        { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' },
      ]),
    });
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 201);
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

describe('the additivity gate (§23 priority 2, spec §6.2)', () => {
  test('removing a Property is refused with a structured, actionable finding', async () => {
    await app.inject({
      method: 'PUT', url: '/padi.authored:draft', headers: auth(DRAFTER),
      payload: draftDocument([]), // reading and units both gone
    });
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 422);
    const findings = response.json().findings;
    const removed = findings.filter((f: { code: string }) => f.code === 'additivity.property_removed');
    assert.equal(removed.length, 2);
    assert.equal(removed[0].gate, 'additivity');
    assert.equal(removed[0].prior_version, 2);
    // No successor name is proposed (spec §7.7).
    assert.ok(!JSON.stringify(findings).includes('suggest'));
  });

  test('redefining a flag is refused, naming the attribute and both values', async () => {
    await app.inject({
      method: 'PUT', url: '/padi.authored:draft', headers: auth(DRAFTER),
      payload: draftDocument([
        { ...propertyV1, Propagate: 'no' }, // flipped
        { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' },
      ]),
    });
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 422);
    const finding = response.json().findings.find(
      (f: { code: string }) => f.code === 'additivity.property_redefined',
    );
    assert.equal(finding.attribute, 'propagate');
    assert.equal(finding.was, true);
    assert.equal(finding.now, false);
  });

  test('adding a MANDATORY Property is refused (spec §6.2)', async () => {
    await app.inject({
      method: 'PUT', url: '/padi.authored:draft', headers: auth(DRAFTER),
      payload: draftDocument([
        propertyV1,
        { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' },
        { Name: 'calibration', Mandatory: 'yes', Propagate: 'no', Description: 'New and required.' },
      ]),
    });
    const response = await app.inject({
      method: 'POST', url: '/padi.authored/publish', headers: auth(PUBLISHER),
    });
    assert.equal(response.statusCode, 422);
    const finding = response.json().findings.find(
      (f: { code: string }) => f.code === 'additivity.added_property_not_optional',
    );
    assert.equal(finding.property, 'calibration');
  });

  test('documentary changes block nothing — §6.3 takes no view of them', () => {
    const before = { properties: [{ name: 'x', description: 'old', role: 'provider' as const, mandatory: true, propagate: true }] };
    const after = { properties: [{ name: 'x', description: 'NEW WORDING', role: 'provider' as const, mandatory: true, propagate: true, sample: '5' }] };
    const result = checkAdditivity(after, before, 1);
    assert.equal(result.additive, true);
    assert.equal(result.documentaryChanges.length, 2);
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
  // "A draft:write credential cannot publish, deprecate, or disclose, under
  // any endpoint or parameter combination; and dry_run=true provably writes
  // nothing."

  test('draft:write cannot publish — not even as a dry run', async () => {
    for (const url of [
      '/padi.authored/publish',
      '/padi.authored/publish?dry_run=true',
      '/padi.authored/publish?dry_run=false',
    ]) {
      const response = await app.inject({ method: 'POST', url, headers: auth(DRAFTER) });
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

  test('draft:write cannot disclose', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored:draft/disclosure', headers: auth(DRAFTER),
      payload: { realm: 'someone-elses-realm', confirm_public: true },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().required_scope, 'disclose');
  });

  test('no token at all is a 401 on every write verb', async () => {
    const attempts: [string, string][] = [
      ['PUT', '/padi.authored:draft'],
      ['POST', '/padi.authored/publish'],
      ['POST', '/padi.authored:2/deprecate'],
      ['PATCH', '/padi.authored:2/header'],
      ['DELETE', '/padi.authored'],
      ['POST', '/padi.authored:draft/disclosure'],
    ];
    for (const [method, url] of attempts) {
      const response = await app.inject({ method: method as never, url, payload: {} });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }
  });

  test('dry_run=true provably writes nothing', async () => {
    // Put a publishable Draft in place, then rehearse and compare EVERYTHING:
    // version rows, draft bytes, and the audit chain head.
    await app.inject({
      method: 'PUT', url: '/padi.authored:draft', headers: auth(DRAFTER),
      payload: draftDocument([
        propertyV1,
        { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' },
        { Name: 'zone', Mandatory: 'no', Propagate: 'no', Description: 'Optional zone.' },
      ]),
    });

    const snapshot = async () =>
      (
        await db.query<{ versions: string; head: string | null; draft: string }>(
          `SELECT
             (SELECT count(*)::text FROM profile_version) AS versions,
             (SELECT max(event_hash) FROM (SELECT event_hash FROM audit_event ORDER BY seq DESC LIMIT 1) h) AS head,
             (SELECT md5(draft_content::text) FROM profile WHERE name = 'padi.authored') AS draft`,
        )
      ).rows[0]!;

    const before = await snapshot();
    const rehearsal = await app.inject({
      method: 'POST', url: '/padi.authored/publish?dry_run=true', headers: auth(PUBLISHER),
    });
    const after = await snapshot();

    assert.equal(rehearsal.statusCode, 200);
    assert.equal(rehearsal.json().dry_run, true);
    assert.equal(rehearsal.json().would_assign_version, 3);
    assert.deepEqual(after, before, 'dry_run left a trace');
  });
});

describe('the disclosure trapdoor through the API (§23 priority 5, §13.3)', () => {
  test('an operated Realm authorizes without ceremony and stays scoped', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored:draft/disclosure', headers: auth(PUBLISHER),
      payload: { realm: 'padi-dev-realm' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().disclosure, 'authorized');
  });

  test('a NON-operated Realm demands explicit confirmation first', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored:draft/disclosure', headers: auth(PUBLISHER),
      payload: { realm: 'partner-realm' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'disclosure.confirmation_required');
    assert.equal(response.json().irreversible, true);

    // And the refusal changed nothing.
    const { rows } = await db.query(`SELECT draft_disclosure FROM profile WHERE name = 'padi.authored'`);
    assert.equal(rows[0]!.draft_disclosure, 'authorized');
  });

  test('confirmed, the trapdoor closes — public, in the same transaction, irreversibly', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.authored:draft/disclosure', headers: auth(PUBLISHER),
      payload: { realm: 'partner-realm', confirm_public: true },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().disclosure, 'public');
    assert.equal(response.json().irreversible, true);

    // The Draft now answers to ANY party on the read path (spec §7.3).
    const anyone = await app.inject({ method: 'GET', url: '/padi.authored:draft' });
    assert.equal(anyone.statusCode, 200);

    // And the database trigger holds the door shut.
    await assert.rejects(
      () => db.query(`UPDATE profile SET draft_disclosure = 'private' WHERE name = 'padi.authored'`),
      /trapdoor/,
    );
  });
});

describe('discard (§13.5)', () => {
  test('a never-published Draft may be discarded, releasing the name', async () => {
    await app.inject({ method: 'PUT', url: '/padi.scratch', headers: auth(DRAFTER) });
    const response = await app.inject({ method: 'DELETE', url: '/padi.scratch', headers: auth(DRAFTER) });
    assert.equal(response.statusCode, 204);

    const gone = await app.inject({ method: 'GET', url: '/padi.scratch' });
    assert.equal(gone.statusCode, 404);
  });

  test('a published name is permanent — discard is a structured 409', async () => {
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
      'profile.register', 'profile.draft', 'profile.publish',
      'profile.deprecate', 'profile.stewardship', 'profile.disclose', 'profile.discard',
    ]) {
      assert.ok(actions.includes(expected), `no audit event for ${expected}`);
    }
  });
});
