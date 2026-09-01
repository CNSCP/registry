/**
 * The MCP server — §15.1, driven exactly as an assistant drives it.
 *
 * Full stack, no mocks anywhere in the path: a real MCP client speaks the
 * protocol over stdio to the real server process, which speaks HTTP to a live
 * authoring host, which runs the real gates against a real database. What
 * passes here is the actual Phase 0 workflow — "hand-authoring by an assistant
 * is the intended publication path" (§25).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { registerAuthoringRoutes, type Credential } from '../src/part-two/routes.ts';
import { registerResolutionRoutes } from '../src/part-three/routes.ts';
import { PgOwnershipStore } from '../src/part-one/pg-store.ts';

const here = dirname(fileURLToPath(import.meta.url));

const AUTHOR: Credential = {
  token: 'mcp-author-'.padEnd(40, 'm'),
  userId: '',
  kind: 'agent',
  principal: 'anto@padi.io',
  scopes: ['draft:write', 'publish', 'deprecate', 'disclose'],
};

let harness: Harness;
let db: pg.Pool;
let app: FastifyInstance;
let client: Client;

/** Call one tool; return its text payload, parsed as JSON where possible. */
async function tool(name: string, args: Record<string, unknown>): Promise<{ raw: string; json?: unknown; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const raw = content[0]?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^HTTP \d+\n/, ''));
  } catch {
    /* not JSON */
  }
  return { raw, json, isError: result.isError === true };
}

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;

  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    const seeded = await applySeed(pgClient);
    const user = await pgClient.query<{ id: string }>(
      `INSERT INTO app_user (oidc_subject, email) VALUES ('oidc|mcp', 'anto@padi.io') RETURNING id`,
    );
    AUTHOR.userId = user.rows[0]!.id;
    await pgClient.query(`INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      seeded.orgId,
      AUTHOR.userId,
    ]);
    await pgClient.query('COMMIT');
  } finally {
    pgClient.release();
  }

  // The authoritative host, on a real TCP port so the MCP subprocess can reach it.
  app = Fastify();
  await registerAuthoringRoutes(app, {
    pool: db,
    ownership: new PgOwnershipStore(db),
    credentials: [AUTHOR],
    operatedRealms: ['padi-dev-realm'],
  });
  await registerResolutionRoutes(app, { db, html: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });

  // The MCP server as a subprocess over stdio — exactly how an assistant runs it.
  client = new Client({ name: 'test-assistant', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', resolve(here, '../src/mcp/server.ts')],
      env: {
        ...process.env,
        CP_REGISTRY_URL: address,
        CP_REGISTRY_TOKEN: AUTHOR.token,
      },
    }),
  );
});

after(async () => {
  await client.close();
  await app.close();
  await harness.close();
});

describe('the toolset', () => {
  test('exposes the authoring verbs and nothing surprising', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'authorize_realm', 'check_publishable', 'check_registration', 'deprecate',
      'discard_draft', 'publish', 'read_draft', 'register_name', 'resolve',
      'update_stewardship', 'write_draft',
    ]);
  });

  test('the irreversible acts say so in their descriptions — the description IS the documentation', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.match(byName['publish']!.description ?? '', /IRREVERSIBLE/);
    assert.match(byName['authorize_realm']!.description ?? '', /IRREVERSIBLE/i);
    assert.match(byName['authorize_realm']!.description ?? '', /Never confirm on your own judgment/);
  });
});

describe('an assistant authors a Profile end to end', () => {
  test('register', async () => {
    const result = await tool('register_name', { name: 'padi.via-mcp' });
    assert.equal(result.isError, false, result.raw);
    assert.equal((result.json as { registered: boolean }).registered, true);
  });

  test('write the Draft', async () => {
    const result = await tool('write_draft', {
      name: 'padi.via-mcp',
      document: {
        Header: {
          'Name': 'padi.via-mcp',
          'Owner': 'Padi, Inc.',
          'Title': 'Authored over MCP',
          'Provider': 'Beacon',
          'Consumer': 'Listener',
          'Description': 'Written by an assistant through the MCP server.',
          'Website': 'https://padi.io/via-mcp',
        },
        Properties: {
          Provider: [{ Name: 'signal', Mandatory: 'yes', Propagate: 'yes', Description: 'The signal.' }],
          Consumer: [],
        },
      },
    });
    assert.equal(result.isError, false, result.raw);
  });

  test('rehearse — check_publishable reports publishable with nothing changed', async () => {
    const result = await tool('check_publishable', { name: 'padi.via-mcp' });
    assert.equal(result.isError, false, result.raw);
    const body = result.json as { publishable: boolean; would_assign_version: number };
    assert.equal(body.publishable, true);
    assert.equal(body.would_assign_version, 1);
  });

  test('publish', async () => {
    const result = await tool('publish', { name: 'padi.via-mcp' });
    assert.equal(result.isError, false, result.raw);
    assert.equal((result.json as { version: number }).version, 1);
  });

  test('and it resolves — same host, plain GET', async () => {
    const result = await tool('resolve', { reference: 'padi.via-mcp:1' });
    assert.equal(result.isError, false);
    assert.equal((result.json as { Header: { Name: string } }).Header.Name, 'padi.via-mcp');
  });

  test('a refusal comes back structured, for the assistant to act on', async () => {
    // Break additivity: drop the mandatory property.
    await tool('write_draft', {
      name: 'padi.via-mcp',
      document: {
        Header: {
          'Name': 'padi.via-mcp', 'Owner': 'Padi, Inc.', 'Title': 'Authored over MCP',
          'Provider': 'Beacon', 'Consumer': 'Listener',
          'Description': 'Reshaped.', 'Website': 'https://padi.io/via-mcp',
        },
        Properties: { Provider: [], Consumer: [] },
      },
    });
    const result = await tool('check_publishable', { name: 'padi.via-mcp' });
    assert.equal(result.isError, true, 'a 422 must surface as an error result');
    const body = result.json as { findings: { code: string; property: string }[] };
    assert.equal(body.findings[0]!.code, 'additivity.property_removed');
    assert.equal(body.findings[0]!.property, 'signal');
  });

  test('the trapdoor challenge reaches the assistant verbatim', async () => {
    const result = await tool('authorize_realm', { name: 'padi.via-mcp', realm: 'someone-elses-realm' });
    assert.equal(result.isError, true);
    const body = result.json as { code: string; irreversible: boolean };
    assert.equal(body.code, 'disclosure.confirmation_required');
    assert.equal(body.irreversible, true);
  });

  test('an unreachable Registry is reported, not thrown', async () => {
    // A second MCP server pointed at a dead port.
    const dead = new Client({ name: 'test-dead', version: '0.0.0' });
    await dead.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--experimental-strip-types', resolve(here, '../src/mcp/server.ts')],
        env: { ...process.env, CP_REGISTRY_URL: 'http://127.0.0.1:9', CP_REGISTRY_TOKEN: 'x'.repeat(40) },
      }),
    );
    try {
      const result = await dead.callTool({ name: 'resolve', arguments: { reference: 'padi.value' } });
      assert.equal(result.isError, true);
      const text = (result.content as { text: string }[])[0]!.text;
      assert.match(text, /unreachable/);
    } finally {
      await dead.close();
    }
  });
});
