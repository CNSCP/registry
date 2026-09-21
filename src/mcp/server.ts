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
 * ONE CREDENTIAL PER SURFACE (§20.3). Acts on the namespace — register,
 * publish, deprecate, steward, release — carry the canon token, and are
 * checked at the authoritative store as they always were. The two workspace
 * tools carry the WORKSPACE credential, and reach the author's own host: a
 * draft is not an act, and the two credentials never substitute for each
 * other. Nothing here combines them into one call; `register_name` with a
 * document makes the two calls in order, which is a client's job and not a
 * server's.
 *
 * Configuration (env):
 *   CP_REGISTRY_URL    the authoring host, e.g. http://127.0.0.1:8081
 *   CP_REGISTRY_TOKEN  bearer token; its scopes decide what the tools may do
 *   CP_WORKSPACE_URL   the host holding the unpublished forms (§20.3);
 *                      defaults to CP_REGISTRY_URL, which is right when that
 *                      host forwards writes to canon — one URL for everything
 *   CP_WORKSPACE_TOKEN the workspace credential. Without it the two workspace
 *                      tools read but cannot save.
 *
 * Run: `npm run mcp` (stdio transport — the standard for local assistants).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env['CP_REGISTRY_URL'] ?? 'http://127.0.0.1:8081';
const TOKEN = process.env['CP_REGISTRY_TOKEN'] ?? '';
const WORKSPACE_BASE = process.env['CP_WORKSPACE_URL'] ?? BASE;
const WORKSPACE_TOKEN = process.env['CP_WORKSPACE_TOKEN'] ?? '';

if (!TOKEN) {
  console.error('CP_REGISTRY_TOKEN is not set. The tools will fail with 401 until it is.');
}

type CallResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * One HTTP call, one result. Errors are NOT thrown: a Registry refusal is a
 * structured document the assistant is meant to read and act on (§15.1), so it
 * comes back as content with isError set, never as an opaque exception.
 */
async function request(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  accept = 'application/cp+json; profile=2026',
  extra: Record<string, string> = {},
): Promise<{ response: Response; text: string } | { failure: string }> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    return { failure: `The host at ${base} is unreachable: ${(error as Error).message}` };
  }
  return { response, text: await response.text() };
}

function result(outcome: { response: Response; text: string } | { failure: string }, prefix = ''): CallResult {
  if ('failure' in outcome) return { isError: true, content: [{ type: 'text', text: outcome.failure }] };
  const { response, text } = outcome;
  const ok = response.status < 400;
  return {
    ...(ok ? {} : { isError: true }),
    content: [{ type: 'text', text: ok ? `${prefix}${text}` : `HTTP ${response.status}\n${text}` }],
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  accept = 'application/cp+json; profile=2026',
): Promise<CallResult> {
  return result(await request(BASE, TOKEN, method, path, body, accept));
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
      'permanent — a never-published name can be released. ' +
      'Pass `document` to also save it as the unpublished form in the workspace (§20.3) once the ' +
      'name is claimed: two calls to two surfaces with two credentials, in order, never one act. ' +
      'If the registration succeeds and the save does not, the name is still registered and the ' +
      'refusal is reported — nothing is rolled back, because a registration is a public act that ' +
      'happened.',
    inputSchema: {
      name: z.string().describe('Two or more lowercase segments, e.g. "padi.meter.flow"'),
      document: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional: the working document to save in the workspace immediately after registering'),
    },
  },
  async ({ name, document }) => {
    const registered = await call('PUT', `/${name}`);
    if (document === undefined || registered.isError) return registered;
    const saved = await saveForm(name, document);
    return {
      ...(saved.isError ? { isError: true } : {}),
      content: [
        { type: 'text', text: `Registered at ${BASE}:\n${registered.content[0]?.text ?? ''}` },
        { type: 'text', text: `Saved to the workspace at ${WORKSPACE_BASE}:\n${saved.content[0]?.text ?? ''}` },
      ],
    };
  },
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

// --- The workspace: the unpublished form, on the author's own host (§20.3) ---
//
// The Registry holds no unpublished content (spec §7.3). A workspace beside a
// local instance does — the author's own, at the name its versions will
// occupy, or under `test.*` for work that has no name yet. These two tools are
// the only ones here that carry the WORKSPACE credential, and the only ones
// that reach CP_WORKSPACE_URL.

/** Save a form. Shared by `save_unpublished` and by `register_name`'s optional document. */
async function saveForm(name: string, document: Record<string, unknown>, ifMatch?: string): Promise<CallResult> {
  if (!WORKSPACE_TOKEN) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'CP_WORKSPACE_TOKEN is not set: this assistant can read unpublished forms but not save them (§20.3).' }],
    };
  }
  const outcome = await request(
    WORKSPACE_BASE,
    WORKSPACE_TOKEN,
    'PUT',
    `/${name}:unpublished`,
    document,
    'application/cp+json; profile=2026',
    ifMatch === undefined ? {} : { 'if-match': ifMatch },
  );
  return result(outcome);
}

server.registerTool(
  'get_unpublished',
  {
    title: 'Read the unpublished form from the workspace',
    description:
      'Returns the working copy of a Profile as its author last saved it, from the workspace on ' +
      'the author\'s own host (§20.3) — NOT from the Registry, which never holds unpublished ' +
      'content (spec §7.3). Needs no credential: a workspace answers reads to anyone who can reach ' +
      'it, which is what lets a testing partner exercise a Profile before it is published. The ' +
      'answer carries Status: Unpublished and no Version, because it is not a version: it may ' +
      'change at any time, and a Connection bound against it is provisional (spec §6.3). ' +
      'The ETag comes back with it — pass that as `if_match` when you save a change, so a ' +
      'co-author\'s newer save is never overwritten unseen.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const outcome = await request(WORKSPACE_BASE, '', 'GET', `/${name}:unpublished`);
    if ('failure' in outcome) return result(outcome);
    const etag = outcome.response.headers.get('etag');
    return result(outcome, etag ? `ETag: ${etag}\n(pass this as if_match to save a change)\n\n` : '');
  },
);

server.registerTool(
  'save_unpublished',
  {
    title: 'Save the unpublished form to the workspace — not a publication',
    description:
      'Writes the working copy to the workspace on the author\'s own host (§20.3). This is NOT ' +
      'publication and creates no version: the form is mutable without restriction, can be ' +
      'reshaped as often as the work requires, and only `publish` ever makes a contract (spec ' +
      '§6.3). Held only for a name registered under a Prefix the workspace\'s organization holds, ' +
      'or under `test.*` where the host admits it; Header.Name must equal the name; Version, Status ' +
      'and Pub Date are dropped, because the Registry assigns those at publication. ' +
      'OVER AN EXISTING FORM `if_match` IS REQUIRED: call get_unpublished, edit what it returns, ' +
      'and pass the ETag it gave you. Without it the workspace answers 428, and with a stale one ' +
      '412 — both mean someone else has saved since you read, so read again and merge. ' +
      DOCUMENT_SHAPE,
    inputSchema: {
      name: z.string(),
      document: z.record(z.string(), z.unknown()).describe('The full working document to save'),
      if_match: z
        .string()
        .optional()
        .describe('The ETag from get_unpublished. Required when a form already exists; omit on the first save.'),
    },
  },
  async ({ name, document, if_match }) => saveForm(name, document, if_match),
);


server.registerTool(
  'lint_profile',
  {
    title: 'Contract lint — advice before the gate, changes nothing',
    description:
      'Reads a candidate document and reports what is wrong with it AS A CONTRACT, which is a ' +
      'different question from whether the Registry will accept it. Findings carry a severity: ' +
      '"refusal" means publication would be refused on this ground and the finding also carries ' +
      'gate: true; "warning" means probably a mistake; "note" means worth knowing. The Registry ' +
      'refuses on none of the warnings or notes — lint is advisory (§16) and never adds a refusal ' +
      'ground. Two checks matter most when a document is being generated rather than deliberated: ' +
      'a Property whose name encodes a direction (the supplying role is already structural), and ' +
      'the permanence note, which names every newly added Property — once published under this ' +
      'name a Property can never be removed or redefined, in this version or any later one. ' +
      'Lint first, revise, lint again, then check_publishable. ' +
      DOCUMENT_SHAPE,
    inputSchema: {
      name: z.string(),
      document: z.record(z.string(), z.unknown()).describe('The full document to lint'),
    },
  },
  async ({ name, document }) => call('POST', `/${name}/lint`, document),
);

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
      'Needs only the register scope: an agent may converge here and hand a publishable document ' +
      'to the person who holds publish. ' +
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
