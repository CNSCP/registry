/**
 * Contract lint — design §16, 14 September 2026.
 *
 * Two things are being asserted, and the second matters more than the first.
 * One: each check fires on a document that should trip it and stays silent on
 * one that should not. Two: lint changes NOTHING about what the Registry does
 * — a document full of findings publishes if it is conformant, and a clean
 * document is refused if it is not additive. Lint that can refuse is not
 * advice, it is house style with a gate, and §16 says it is neither.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { registerAuthoringRoutes, type Credential } from '../src/part-two/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';
import { lint, tally, type Finding } from '../src/profile/lint.ts';
import { parseProfileVersion } from '../src/profile/spec2026.ts';

const AGENT: Credential = {
  token: 'lint-agent-'.padEnd(40, 'a'),
  userId: '',
  kind: 'agent',
  principal: 'anto@padi.io',
  scopes: ['register', 'steward', 'release'],
};
const PUBLISHER: Credential = {
  token: 'lint-publisher-'.padEnd(40, 'p'),
  userId: '',
  kind: 'human',
  scopes: ['register', 'steward', 'release', 'publish', 'deprecate'],
};
const NO_SCOPES: Credential = {
  token: 'lint-nothing-'.padEnd(40, 'n'),
  userId: '',
  kind: 'agent',
  principal: 'anto@padi.io',
  scopes: ['release'],
};

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;

const auth = (c: Credential) => ({ authorization: `Bearer ${c.token}` });

function document(
  properties: Record<string, unknown>[],
  header: Record<string, unknown> = {},
  channels?: Record<string, unknown>[],
) {
  return {
    Header: {
      'Name': 'padi.linted',
      'Owner': 'Padi, Inc.',
      'Title': 'A linted Profile',
      'Provider': 'Sensor',
      'Consumer': 'Display',
      'Description': 'Used to exercise the lint.',
      'Website': 'https://padi.io/linted',
      ...header,
    },
    Properties: { Provider: properties, Consumer: [] },
    ...(channels ? { Channels: channels } : {}),
  };
}

const reading = { Name: 'reading', Mandatory: 'yes', Propagate: 'yes', Description: 'The reading.' };
const units = { Name: 'units', Mandatory: 'no', Propagate: 'yes', Description: 'The units.' };

/** Lint a document the way the route does, with no prior versions. */
function lintOf(doc: ReturnType<typeof document>, priors: Parameters<typeof lint>[1] = {}): Finding[] {
  return lint(parseProfileVersion(doc as never, 'padi.linted'), priors);
}

const checks = (findings: Finding[]) => findings.map((f) => f.check);

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const seeded = await applySeed(client);
    const user = await client.query<{ id: string }>(
      `INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|lint', 'anto@padi.io') RETURNING id`,
    );
    await client.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      seeded.orgId, user.rows[0]!.id,
    ]);
    for (const c of [AGENT, PUBLISHER, NO_SCOPES]) c.userId = user.rows[0]!.id;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  app = Fastify();
  await registerAuthoringRoutes(app, {
    pool: db, ownership: new PgOwnershipStore(db), credentials: [AGENT, PUBLISHER, NO_SCOPES],
  });
  await app.ready();
  await app.inject({ method: 'PUT', url: '/padi.linted', headers: auth(AGENT) });
});

after(async () => {
  await app.close();
  await harness.close();
});

describe('the checks (§16)', () => {
  test('a sound first version draws only the permanence note', () => {
    const findings = lintOf(document([reading, units]));
    assert.deepEqual(checks(findings), ['version.permanence']);
    assert.equal(findings[0]!.severity, 'note');
    assert.equal(findings[0]!.gate, undefined);
  });

  test('a direction prefix is a warning, and names what to do instead', () => {
    const findings = lintOf(document([{ ...reading, Name: 'in_reading' }]));
    const f = findings.find((x) => x.check === 'property.direction-prefix');
    assert.ok(f);
    assert.equal(f.severity, 'warning');
    assert.equal(f.where, 'Properties[0].Name');
    assert.match(f.message, /already declares which role supplies it/);
  });

  test('every direction marker in the list fires', () => {
    for (const name of ['in_x', 'out_x', 'tx_x', 'rx_x', 'send_x', 'recv_x', 'server_x', 'client_x']) {
      const findings = lintOf(document([{ ...reading, Name: name }]));
      assert.ok(
        findings.some((f) => f.check === 'property.direction-prefix'),
        `"${name}" should be flagged`,
      );
    }
  });

  test('a quantity that merely starts with those letters does NOT fire', () => {
    // The boundary this check lives or dies on: `input_pressure` is a
    // pressure, not a direction, and a lint that cries wolf is ignored.
    for (const name of ['input_pressure', 'output_shaft_speed', 'outside_temperature', 'clientele_count']) {
      const findings = lintOf(document([{ ...reading, Name: name }]));
      assert.ok(
        !findings.some((f) => f.check === 'property.direction-prefix'),
        `"${name}" should not be flagged`,
      );
    }
  });

  test('capture language in the Header is a warning', () => {
    const findings = lintOf(
      document([reading], { Description: 'Enacted only in the Acme realm, and only with Acme’s Governor.' }),
    );
    const f = findings.find((x) => x.check === 'profile.non-capture');
    assert.ok(f);
    assert.equal(f.where, 'Header.Description');
    assert.equal(f.severity, 'warning');
  });

  test('capture language in a Property Description is a warning against that Property', () => {
    const findings = lintOf(
      document([{ ...reading, Description: 'The reading; the Governor must approve each read.' }]),
    );
    const f = findings.find((x) => x.check === 'profile.non-capture');
    assert.ok(f);
    assert.equal(f.where, 'Properties[0].Description');
  });

  test('merely mentioning a realm is not capture', () => {
    // Conservative by construction: the noun alone says nothing.
    const findings = lintOf(
      document([reading], { Description: 'Readings cross a realm boundary without transformation.' }),
    );
    assert.ok(!findings.some((f) => f.check === 'profile.non-capture'));
  });

  test('a missing REQUIRED Header field is a refusal, and carries gate', () => {
    const doc = document([reading]);
    delete (doc.Header as Record<string, unknown>)['Owner'];
    const findings = lintOf(doc);
    const f = findings.find((x) => x.check === 'header.incomplete');
    assert.ok(f);
    assert.equal(f.severity, 'refusal');
    assert.equal(f.gate, true);
    assert.equal(f.where, 'Header.Owner');
  });

  test('Version, Pub Date and Status are never reported missing — the Registry assigns them', () => {
    const findings = lintOf(document([reading]));
    for (const f of findings) assert.ok(!/Header\.(Version|Pub Date|Status)/.test(f.where));
  });

  test('the permanence note names each newly added Property against priors', () => {
    const priors = [{ version: 1, content: parseProfileVersion(document([reading]) as never).versions![0]! }];
    const findings = lintOf(document([reading, units]), { priors });
    const permanence = findings.filter((f) => f.check === 'version.permanence');
    assert.equal(permanence.length, 1);
    assert.match(permanence[0]!.message, /"units" is new in this version/);
    assert.match(permanence[0]!.message, /never be removed or redefined/);
  });

  test('a removal is reported as a refusal with gate, the same ground the publish gate uses', () => {
    const priors = [{ version: 1, content: parseProfileVersion(document([reading, units]) as never).versions![0]! }];
    const findings = lintOf(document([reading]), { priors });
    const f = findings.find((x) => x.check === 'version.additivity');
    assert.ok(f);
    assert.equal(f.severity, 'refusal');
    assert.equal(f.gate, true);
  });

  test('tally counts, and is not a score', () => {
    const findings = lintOf(document([{ ...reading, Name: 'in_reading' }]));
    const t = tally(findings);
    assert.equal(t.warning, 1);
    assert.equal(t.note, 1);
    assert.equal(t.refusal, 0);
  });
});

describe('the route (§16, §15.1)', () => {
  test('POST /<name>/lint returns findings and writes nothing', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM audit_event`);
    const response = await app.inject({
      method: 'POST', url: '/padi.linted/lint', headers: auth(AGENT),
      payload: document([{ ...reading, Name: 'out_reading' }]),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.advisory, true);
    assert.ok(body.lint.findings.some((f: Finding) => f.check === 'property.direction-prefix'));
    const after = await db.query(`SELECT count(*)::int AS n FROM audit_event`);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });

  test('it needs the register scope, and nothing more', async () => {
    const refused = await app.inject({
      method: 'POST', url: '/padi.linted/lint', headers: auth(NO_SCOPES), payload: document([reading]),
    });
    assert.equal(refused.statusCode, 403);

    const anonymous = await app.inject({
      method: 'POST', url: '/padi.linted/lint', payload: document([reading]),
    });
    assert.equal(anonymous.statusCode, 401);
  });

  test('a document the parser cannot read is a structured 422, not a crash', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.linted/lint', headers: auth(AGENT),
      payload: { Header: { Name: 'padi.linted' }, Properties: { Provider: [{ Name: 'x' }], Consumer: [] } },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'lint.malformed');
  });

  test('lint addresses the name, not a version', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.linted:1/lint', headers: auth(AGENT), payload: document([reading]),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'grammar.name');
  });
});

describe('lint changes nothing about what the Registry does (§16)', () => {
  test('a rehearsal carries the findings alongside the verdict', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.linted/publish?dry_run=true', headers: auth(AGENT),
      payload: document([{ ...reading, Name: 'in_reading' }]),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.publishable, true);
    assert.ok(body.lint.findings.some((f: Finding) => f.check === 'property.direction-prefix'));
  });

  test('a document with warnings publishes anyway — lint is not a gate', async () => {
    const response = await app.inject({
      method: 'POST', url: '/padi.linted/publish', headers: auth(PUBLISHER),
      payload: document([
        { ...reading, Name: 'in_reading', Description: 'The reading; only the Governor may enact it.' },
      ]),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().version, 1);
  });

  test('a document with no findings at all is still refused if it is not additive', async () => {
    // Clean by every advisory measure, and refused on the one ground that is
    // actually the Registry's: the published Property is gone.
    const response = await app.inject({
      method: 'POST', url: '/padi.linted/publish', headers: auth(PUBLISHER),
      payload: document([units]),
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().publishable, false);
    assert.ok(response.json().findings.some((f: { code: string }) => f.code === 'additivity.property_removed'));
  });
});
