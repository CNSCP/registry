/**
 * The authoritative host — `cp.cnscp.io` (design §4.4).
 *
 * The AUTHORITATIVE PROFILE of the host contract: the resolution profile (every
 * GET of §19) plus every other verb on those same paths (§15). Only one
 * instance anywhere implements this; local instances serve the resolution
 * profile alone and refuse writes.
 *
 * Authoring and resolution share paths and split by method, so both route sets
 * mount on one Fastify instance and one origin — no CORS sits between a client
 * and its work (§4.4).
 *
 * Credentials, Phase 0 style: a static table from the environment. The token's
 * SCOPES decide what it may do (§15.2) — an agent's token normally carries
 * draft:write alone, and a human's adds publish/deprecate/disclose. OIDC and
 * credential issuance are Phase 2 (§25).
 *
 *   CP_AUTHOR_TOKEN      bearer token (>= 32 chars)
 *   CP_AUTHOR_USER_ID    app_user id it acts as
 *   CP_AUTHOR_KIND       human | service | agent          (default: agent)
 *   CP_AUTHOR_PRINCIPAL  the human behind a non-human actor (§4.3)
 *   CP_AUTHOR_SCOPES     comma-separated                  (default: draft:write)
 *   CP_OPERATED_REALMS   comma-separated Realms the owner operates (§13.3)
 */

import Fastify from 'fastify';
import { getPool } from './db.ts';
import { PgOwnershipStore } from './part-one/pg-store.ts';
import { registerAuthoringRoutes, type Credential, type Scope } from './part-two/routes.ts';
import { registerResolutionRoutes } from './part-three/routes.ts';

const token = process.env['CP_AUTHOR_TOKEN'];
const userId = process.env['CP_AUTHOR_USER_ID'];
if (!token || !userId) {
  throw new Error('CP_AUTHOR_TOKEN and CP_AUTHOR_USER_ID are required — the authoring verbs will not serve without a credential.');
}

const kind = (process.env['CP_AUTHOR_KIND'] ?? 'agent') as Credential['kind'];
const principal = process.env['CP_AUTHOR_PRINCIPAL'];
const scopes = (process.env['CP_AUTHOR_SCOPES'] ?? 'draft:write').split(',').map((s) => s.trim()) as Scope[];

const credential: Credential = {
  token,
  userId,
  kind,
  ...(principal ? { principal } : {}),
  scopes,
};

const app = Fastify({ logger: true });
const pool = getPool();

await registerAuthoringRoutes(app, {
  pool,
  ownership: new PgOwnershipStore(pool),
  credentials: [credential],
  operatedRealms: (process.env['CP_OPERATED_REALMS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});
await registerResolutionRoutes(app, { db: pool, html: process.env['RENDER_HTML'] !== 'false' });

const port = Number(process.env['CP_PORT'] ?? 8082);
const host = process.env['BIND_HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
