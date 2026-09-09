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
 * rejections passed through verbatim, and dry_run as a first-class tool so it
 * can converge on a publishable document without ever risking the one
 * irreversible act. The workspace is the assistant's own files — the 8 Sept
 * revision moved unpublished content out of the Registry (spec §7.3), so a
 * document exists here only at the moment of (rehearsed or real) publication.
 * Publication is described as IRREVERSIBLE in its tool description, because
 * the tool description IS the assistant's documentation.
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
      '`name:2` returns that immutable version; a single dotless segment returns the allocation ' +
      'page listing everything beneath that Prefix. `name:unpublished` is never resolved by the ' +
      'Registry (spec §7.2): unpublished content lives with its author.',
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

// --- Registration and the working document ----------------------------------

server.registerTool(
  'register_name',
  {
    title: 'Register a Profile name',
    description:
      'Claims the name under its Prefix — and nothing else: the Registry holds no unpublished ' +
      'content (spec §6.3, §7.3), so your working document stays with you until you publish it. ' +
      'Idempotent: registering a name you already hold is a no-op. Requires the owner\'s ' +
      'authorization to exist for you; a structured 403 explains any refusal. Registration is not ' +
      'permanent — a never-published name can be released.',
    inputSchema: { name: z.string().describe('Two or more lowercase segments, e.g. "padi.meter.flow"') },
  },
  async ({ name }) => call('PUT', `/${name}`),
);

const DOCUMENT_SHAPE =
  'The full 2026 document: { Header: { Name, Owner, Title, Provider, Consumer, Description, ' +
  'Website }, Properties: { Provider: [...], Consumer: [...] }, Channels?: [...] }. Each Property ' +
  'carries Name, Mandatory ("yes"/"no"), Propagate ("yes"/"no"), Description, and optionally ' +
  'Default and Sample; each Channel carries Name, Mode (stream|message|datagram), Protocol, ' +
  'Description, and where the protocol has roles, "Provider Role" and "Consumer Role". ' +
  'Header.Name must equal the registered name; leave Version, Pub Date and Status out — the ' +
  'Registry assigns them. Your working copy is YOURS: the Registry holds no unpublished content ' +
  '(spec §7.3), so keep the document in your own files between calls.';

server.registerTool(
  'check_publishable',
  {
    title: 'Dry-run publication — every gate, no changes',
    description:
      'Sends the document through the full set of publication gates (Header completeness §6.6, ' +
      'at least one Property and one shared name space with Channels §6.4–§6.5, additivity against ' +
      'every prior published version §6.2) and reports exactly what a real publish would do, ' +
      'changing NOTHING and retaining nothing. Converge here before risking the irreversible act. ' +
      'Findings are structured: each names its gate, the offending element, and the rule. ' +
      DOCUMENT_SHAPE,
    inputSchema: {
      name: z.string(),
      document: z.record(z.string(), z.unknown()).describe('The full document to rehearse'),
    },
  },
  async ({ name, document }) => call('POST', `/${name}/publish?dry_run=true`, document),
);

// --- The irreversible act -----------------------------------------------------

server.registerTool(
  'publish',
  {
    title: 'Publish the document as the next version — IRREVERSIBLE',
    description:
      'IRREVERSIBLE. Freezes the document as a numbered, immutable version and makes the name ' +
      'permanent (spec §6.2, §7.3). A published version can NEVER be altered or deleted; a bad contract, ' +
      'published, is a bad contract forever — the only remedies are deprecation and a new name. ' +
      'Run check_publishable with the same document first, and publish only when it reports ' +
      'publishable: true. The Registry keeps only what it publishes; your working copy remains yours.',
    inputSchema: {
      name: z.string(),
      document: z.record(z.string(), z.unknown()).describe('The full document to publish'),
    },
  },
  async ({ name, document }) => call('POST', `/${name}/publish`, document),
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

// --- The operator plane (§9.2 — one act exists) ------------------------------

server.registerTool(
  'allocate_tlp',
  {
    title: 'Allocate a new Top Level Prefix — OPERATOR RULING',
    description:
      'OPERATOR ACT: allocates a new Top Level Prefix to an organization, creating ownership in ' +
      'the namespace. This is a governance ruling, not an authoring step — perform it only on the ' +
      'operator\'s explicit instruction, never on your own judgment, and rehearse with ' +
      'dry_run: true first. The ruling must name its §8.1 evidence (what was verified and how); ' +
      'policy refusals (spec-reserved, withheld, restricted Prefixes) are final and are not ' +
      'overridable here. Requires the "operator" scope, which authoring credentials do not carry ' +
      'by default. Optionally grants one user day-one admin membership in the holder ' +
      'organization, since an allocation nobody can write under satisfies authorizes() for nobody.',
    inputSchema: {
      tlp: z.string().describe('A single lowercase segment, e.g. "cimetrics"'),
      organization_name: z.string().describe('The holder. Reused by exact name if it exists, created otherwise'),
      organization_website: z.string().optional(),
      organization_contact_email: z.string().optional(),
      evidence: z.string().describe('The §8.1 evidence the ruling rests on — what was verified, and how'),
      term_years: z.number().int().min(1).max(100).optional().describe('§8.2 renewable term; recorded as expires_at'),
      notes: z.string().optional().describe('Published on the allocation page (§19.3)'),
      member_user_id: z.string().optional().describe('app_user id to grant day-one admin membership'),
      dry_run: z.boolean().optional().describe('Run every check, change nothing'),
    },
  },
  async ({ tlp, organization_name, organization_website, organization_contact_email, evidence, term_years, notes, member_user_id, dry_run }) =>
    call('POST', `/operator/allocations${dry_run ? '?dry_run=true' : ''}`, {
      tlp,
      organization: {
        name: organization_name,
        ...(organization_website !== undefined ? { website: organization_website } : {}),
        ...(organization_contact_email !== undefined ? { contact_email: organization_contact_email } : {}),
      },
      evidence,
      ...(term_years !== undefined ? { term_years } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(member_user_id !== undefined ? { member_user_id } : {}),
    }),
);

server.registerTool(
  'release_name',
  {
    title: 'Release a never-published name',
    description:
      'Gives up the registration. Available only while no version has ever been published — "a name ' +
      'with no published versions MAY be released by its owner" (spec §7.3); a name with published ' +
      'versions is permanent, and the Registry refuses with a structured 409.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => call('DELETE', `/${name}`),
);

await server.connect(new StdioServerTransport());
