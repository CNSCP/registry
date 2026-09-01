/**
 * The MCP server over the authoring verbs — design §15.1, §23.
 *
 *   "a thin MCP server over the authoring verbs ... Machine and agent
 *    authoring is a first-class path (§15.1), not an afterthought. Worth
 *    building early: hand-authoring by an assistant is the Phase 0
 *    publication path (§25)."
 *
 * THIN is the design constraint, and it is structural rather than aesthetic:
 * §4.4 gives the console "no privileged path of its own" — it authenticates
 * and then calls the same API as every other client. The same applies here.
 * This process holds a bearer token and speaks HTTP to the authoring host;
 * it never touches the database, so every gate, scope check and audit write
 * happens exactly once, in the one place it is implemented. A fatter server
 * that reached into Postgres would be a second authorization path — the thing
 * the seam design (§4.1) exists to prevent.
 *
 * What the assistant gets is the §15.1 contract: structured, actionable
 * rejections passed through verbatim; dry_run as a first-class tool so it can
 * converge on a publishable Draft without ever risking an irreversible act;
 * and the Draft as its safe workspace. The two irreversible acts — publish,
 * and disclosure to a non-operated Realm — are described as such in their tool
 * descriptions, because the tool description IS the assistant's documentation.
 *
 * Configuration (env):
 *   CP_REGISTRY_URL    the authoring host, e.g. http://127.0.0.1:8081
 *   CP_REGISTRY_TOKEN  bearer token; its scopes decide what the tools may do
 *
 * Run: `npm run mcp` (stdio transport — the standard for local assistants).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env['CP_REGISTRY_URL'] ?? 'http://127.0.0.1:8081';
const TOKEN = process.env['CP_REGISTRY_TOKEN'] ?? '';

if (!TOKEN) {
  console.error('CP_REGISTRY_TOKEN is not set. The tools will fail with 401 until it is.');
}

type CallResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * One HTTP call, one result. Errors are NOT thrown: a Registry refusal is a
 * structured document the assistant is meant to read and act on (§15.1), so it
 * comes back as content with isError set, never as an opaque exception.
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  accept = 'application/cp+json; profile=2026',
): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: `The Registry at ${BASE} is unreachable: ${(error as Error).message}` }],
    };
  }

  const text = await response.text();
  const ok = response.status < 400;
  return {
    ...(ok ? {} : { isError: true }),
    content: [
      {
        type: 'text',
        text: ok ? text : `HTTP ${response.status}\n${text}`,
      },
    ],
  };
}

const server = new McpServer({ name: 'cp-registry', version: '0.1.0' });

// --- Reading (the resolution profile — safe, no scopes involved) ------------

server.registerTool(
  'resolve',
  {
    title: 'Resolve a Profile, version, or allocation',
    description:
      'GET a reference from the Registry. A dotted name returns its published versions; ' +
      '`name:2` returns that immutable version; `name:draft` returns the Draft where disclosure permits; ' +
      'a single dotless segment returns the allocation page listing everything beneath that Prefix.',
    inputSchema: { reference: z.string().describe('e.g. "acme.meter.flow", "acme.meter.flow:2", or "acme"') },
  },
  async ({ reference }) => call('GET', `/${reference}`),
);

server.registerTool(
  'check_registration',
  {
    title: 'Is this name registered, and since when?',
    description:
      'Public fact per spec §7.3 — registration date confers nothing, and a name long ' +
      'registered but never published can be seen for what it is.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => call('GET', `/${name}/registration`),
);

// --- The workspace (draft:write) ---------------------------------------------

server.registerTool(
  'register_name',
  {
    title: 'Register a Profile name',
    description:
      'Claims the name under its Prefix and creates the Draft (design §13.1). Idempotent: ' +
      'registering a name you already hold is a no-op. Requires the owner\'s authorization ' +
      'to exist for you (spec §7.3); a structured 403 explains any refusal. Registration is ' +
      'NOT permanent — an unpublished Draft can be discarded, releasing the name.',
    inputSchema: { name: z.string().describe('Two or more lowercase segments, e.g. "padi.meter.flow"') },
  },
  async ({ name }) => call('PUT', `/${name}`),
);

server.registerTool(
  'write_draft',
  {
    title: 'Replace the Draft content',
    description:
      'The Draft is your safe workspace (spec §6.2): mutable without restriction, not a contract, ' +
      'and — while private — visible to no one else. Generate, test, discard and regenerate as often ' +
      'as the work requires; no gate runs here. Content is the 2026 document shape: ' +
      '{ Header: { Name, Owner, Title, Provider, Consumer, Description, Website }, ' +
      'Properties: { Provider: [...], Consumer: [...] } } with each Property carrying ' +
      'Name, Mandatory ("yes"/"no"), Propagate ("yes"/"no"), Description, and optionally Sample. ' +
      'Header.Name must equal the registered name. Version, Pub Date and Status are the ' +
      'Registry\'s to assign — leave them out.',
    inputSchema: {
      name: z.string(),
      document: z.record(z.string(), z.unknown()).describe('The full Draft document; replaces what is there'),
    },
  },
  async ({ name, document }) => call('PUT', `/${name}:draft`, document),
);

server.registerTool(
  'read_draft',
  {
    title: 'Read the Draft',
    description: 'Fetches the current Draft content for a name you can see.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => call('GET', `/${name}:draft`),
);

server.registerTool(
  'check_publishable',
  {
    title: 'Dry-run publication — every gate, no changes',
    description:
      'Runs the full set of publication gates (Header completeness per spec §6.4, property-name ' +
      'uniqueness per §6.3, and additivity against the highest published version per §6.2) and ' +
      'reports exactly what a real publish would do, changing NOTHING. Use this to converge on a ' +
      'publishable Draft before ever risking the irreversible act. Findings are structured: each ' +
      'names its gate, the offending element, and the rule. Requires the publish scope, since it ' +
      'rehearses publication.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => call('POST', `/${name}/publish?dry_run=true`),
);

// --- The irreversible acts (publish · disclose) ------------------------------

server.registerTool(
  'publish',
  {
    title: 'Publish the Draft as the next version — IRREVERSIBLE',
    description:
      'IRREVERSIBLE. Freezes the Draft\'s content as a numbered, immutable version and makes the name ' +
      'permanent (spec §6.2, §7.3). A published version can NEVER be altered or deleted; a bad contract, ' +
      'published, is a bad contract forever — the only remedies are deprecation and a new name. ' +
      'Run check_publishable first and publish only when it reports publishable: true. ' +
      'The Draft persists afterwards as your workspace for the next version.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => call('POST', `/${name}/publish`),
);

server.registerTool(
  'deprecate',
  {
    title: 'Deprecate a published version',
    description:
      'Excludes the version from selection for new Connections (spec §6.2). Everything else is ' +
      'unchanged: still immutable, still resolvable, existing Connections unaffected. This is the ' +
      'safety valve when something published turns out to be wrong, and it is reversible in ' +
      'practice — republishing the same content as a new version is always available.',
    inputSchema: { name: z.string(), version: z.number().int().min(1) },
  },
  async ({ name, version }) => call('POST', `/${name}:${version}/deprecate`),
);

server.registerTool(
  'update_stewardship',
  {
    title: 'Update Owner or Website on a published version',
    description:
      'The only Header change permitted after publication (spec §6.4): Owner, because a Prefix may ' +
      'change hands; Website, because the document it points to may move. Changes no contract and ' +
      'creates no version.',
    inputSchema: {
      name: z.string(),
      version: z.number().int().min(1),
      owner: z.string().optional(),
      website: z.string().optional(),
    },
  },
  async ({ name, version, owner, website }) =>
    call('PATCH', `/${name}:${version}/header`, {
      ...(owner !== undefined ? { Owner: owner } : {}),
      ...(website !== undefined ? { Website: website } : {}),
    }),
);

server.registerTool(
  'authorize_realm',
  {
    title: 'Authorize a Realm to see the Draft — MAY BE IRREVERSIBLE',
    description:
      'MAY BE IRREVERSIBLE. Authorizes a Realm to bind against the Draft (design §13.3). A Realm the ' +
      'owner operates is scoped and safe. A Realm the owner does NOT operate is the trapdoor: sharing ' +
      'is disclosure, and the Draft becomes answerable to ANY party thereafter, irreversibly (spec §7.3). The ' +
      'Registry returns a confirmation challenge in that case; pass confirm_public: true only after ' +
      'the human you act for has decided. Never confirm on your own judgment.',
    inputSchema: {
      name: z.string(),
      realm: z.string(),
      confirm_public: z.boolean().optional()
        .describe('Required to accept the irreversible public disclosure of a non-operated Realm'),
    },
  },
  async ({ name, realm, confirm_public }) =>
    call('POST', `/${name}:draft/disclosure`, {
      realm,
      ...(confirm_public !== undefined ? { confirm_public } : {}),
    }),
);

server.registerTool(
  'discard_draft',
  {
    title: 'Discard an unpublished Draft, releasing the name',
    description:
      'Available only while no version has ever been published (spec §7.3). A name with published ' +
      'versions is permanent and cannot be discarded — the Registry refuses with a structured 409.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => call('DELETE', `/${name}`),
);

await server.connect(new StdioServerTransport());
