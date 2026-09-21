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
  scopes: ['register', 'steward', 'release', 'publish', 'deprecate', 'operator'],
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
      'allocate_tlp', 'check_publishable', 'check_registration', 'deprecate', 'get_unpublished',
      'lint_profile', 'publish', 'register_name', 'release_name', 'resolve', 'save_unpublished',
      'update_stewardship',
    ]);
  });

  test('the irreversible act says so, and the tools teach the new architecture', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.match(byName['publish']!.description ?? '', /IRREVERSIBLE/);
    // The operator act announces itself as a governance ruling, to be taken
    // only on the operator's explicit word.
    assert.match(byName['allocate_tlp']!.description ?? '', /OPERATOR ACT/);
    assert.match(byName['allocate_tlp']!.description ?? '', /explicit instruction/);
    // The workspace moved out of the Registry (8 Sept §7.3), and the tool
    // descriptions — the assistant's documentation — must say so.
    assert.match(byName['check_publishable']!.description ?? '', /Registry holds no unpublished content/);
    assert.match(byName['register_name']!.description ?? '', /holds no unpublished\s+content|working document stays with you/);
    // Lint must announce that it is advice, or an agent will treat a clean
    // lint as permission and a warning as a refusal (§16.1).
    assert.match(byName['lint_profile']!.description ?? '', /advisory|never adds a refusal ground/);
    assert.match(byName['lint_profile']!.description ?? '', /can never be removed or redefined/);
    // The workspace tools must not read as a second way to publish, and must
    // teach the co-author guard — the tool description IS the documentation.
    assert.match(byName['save_unpublished']!.description ?? '', /NOT\s+publication|not\s+publication/);
    assert.match(byName['save_unpublished']!.description ?? '', /if_match/);
    assert.match(byName['get_unpublished']!.description ?? '', /author's own host|Needs no credential/);
    assert.doesNotMatch(byName['save_unpublished']!.description ?? '', /IRREVERSIBLE/);
  });

  test('the workspace tools are configured apart from the Registry, and say so when they are not', async () => {
    // This server runs with no CP_WORKSPACE_TOKEN: reads would go to
    // CP_WORKSPACE_URL (defaulting to the Registry), saves refuse locally
    // rather than sending a Registry token to a workspace.
    const saved = await tool('save_unpublished', { name: 'padi.mcp.ws', document: { Header: { Name: 'padi.mcp.ws' } } });
    assert.equal(saved.isError, true);
    assert.match(saved.raw, /CP_WORKSPACE_TOKEN is not set/);
  });
});

describe('an assistant authors a Profile end to end', () => {
  test('register', async () => {
    const result = await tool('register_name', { name: 'padi.via-mcp' });
    assert.equal(result.isError, false, result.raw);
    assert.equal((result.json as { registered: boolean }).registered, true);
  });

  // The assistant's working document — held HERE, in the assistant's own
  // space, exactly as 8 Sept §7.3 intends. The Registry sees it only inside
  // check_publishable and publish calls.
  const WORKING_DOCUMENT = {
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
  };

  test('rehearse — check_publishable carries the document and changes nothing', async () => {
    const result = await tool('check_publishable', { name: 'padi.via-mcp', document: WORKING_DOCUMENT });
    assert.equal(result.isError, false, result.raw);
    const body = result.json as { publishable: boolean; would_assign_version: number };
    assert.equal(body.publishable, true);
    assert.equal(body.would_assign_version, 1);
  });

  test('publish — the same document, the real act', async () => {
    const result = await tool('publish', { name: 'padi.via-mcp', document: WORKING_DOCUMENT });
    assert.equal(result.isError, false, result.raw);
    assert.equal((result.json as { version: number }).version, 1);
  });

  test('and it resolves — same host, plain GET', async () => {
    const result = await tool('resolve', { reference: 'padi.via-mcp:1' });
    assert.equal(result.isError, false);
    assert.equal((result.json as { Header: { Name: string } }).Header.Name, 'padi.via-mcp');
  });

  test('a refusal comes back structured, for the assistant to act on', async () => {
    // Break additivity: drop the mandatory property from the working document.
    const reshaped = JSON.parse(JSON.stringify(WORKING_DOCUMENT));
    reshaped.Properties.Provider = [];
    const result = await tool('check_publishable', { name: 'padi.via-mcp', document: reshaped });
    assert.equal(result.isError, true, 'a 422 must surface as an error result');
    const body = result.json as { findings: { code: string; property?: string }[] };
    assert.ok(body.findings.some((f) => f.code === 'additivity.property_removed'));
    assert.ok(body.findings.some((f) => f.code === 'properties.none'));
  });

  test(':unpublished is never resolved, and the tool description said so', async () => {
    const result = await tool('resolve', { reference: 'padi.via-mcp:unpublished' });
    assert.equal(result.isError, true);
    const body = result.json as { resolvable: boolean };
    assert.equal(body.resolvable, false);
  });

  test('the operator act works over MCP: allocate, then author beneath the new Prefix', async () => {
    // Rehearse first, exactly as the tool description instructs.
    const rehearsed = await tool('allocate_tlp', {
      tlp: 'viamcp',
      organization_name: 'Via MCP GmbH',
      evidence: 'test ruling: fictional organization for the MCP allocation flow',
      dry_run: true,
    });
    assert.equal(rehearsed.isError, false, rehearsed.raw);
    assert.equal((rehearsed.json as { allocatable: boolean }).allocatable, true);

    // The ruling. The MCP credential's user becomes the day-one admin.
    const allocated = await tool('allocate_tlp', {
      tlp: 'viamcp',
      organization_name: 'Via MCP GmbH',
      evidence: 'test ruling: fictional organization for the MCP allocation flow',
      member_user_id: AUTHOR.userId,
    });
    assert.equal(allocated.isError, false, allocated.raw);
    assert.equal((allocated.json as { allocated: boolean }).allocated, true);

    // The point of the membership: the seam now authorizes authoring beneath it.
    const registered = await tool('register_name', { name: 'viamcp.probe' });
    assert.equal(registered.isError, false, registered.raw);

    // And the allocation page answers for the new Prefix.
    const page = await tool('resolve', { reference: 'viamcp' });
    assert.equal(page.isError, false);
    assert.equal((page.json as { holder: string }).holder, 'Via MCP GmbH');
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
