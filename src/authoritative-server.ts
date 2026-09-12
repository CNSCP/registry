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
 * Credentials: the `credential` table (migration 10), minted and revoked with
 * the operator CLI, plus — optionally — one static credential from the
 * environment for bootstrapping. A token's SCOPES decide what it may do
 * (§15.2): an agent normally carries register · steward · release, a person
 * adds publish and deprecate. OIDC is Phase 2 (§25).
 *
 *   CP_AUTHOR_TOKEN      bearer token (>= 32 chars)          optional
 *   CP_AUTHOR_USER_ID    app_user id it acts as
 *   CP_AUTHOR_KIND       human | service | agent             (default: agent)
 *   CP_AUTHOR_PRINCIPAL  the human behind a non-human actor (§4.3)
 *   CP_AUTHOR_SCOPES     comma-separated; 'draft:write' still accepted as the three
 */

import Fastify from 'fastify';
import { getPool } from './db.ts';
import { PgOwnershipStore } from './part-one/pg-store.ts';
import { registerAuthoringRoutes, parseScopes, type Credential } from './part-two/routes.ts';
import { findByToken, touch } from './credentials/store.ts';
import { registerResolutionRoutes } from './part-three/routes.ts';
import { identityConfigFromEnv, registerIdentityRoutes } from './identity/routes.ts';

// Credentials come from two places (§15.2). The TABLE is the real one:
// minted with `npm run operator -- credential mint`, looked up by hash,
// revocable. The ENVIRONMENT credential is the Phase 0 bootstrap form, still
// honoured so a fresh deployment can mint its first row — optional now, and
// meant to be removed from the environment once the table carries the real
// tokens (deploy/CREDENTIALS.md).
const token = process.env['CP_AUTHOR_TOKEN'];
const userId = process.env['CP_AUTHOR_USER_ID'];
const staticCredentials: Credential[] = [];
if (token && userId) {
  const kind = (process.env['CP_AUTHOR_KIND'] ?? 'agent') as Credential['kind'];
  const principal = process.env['CP_AUTHOR_PRINCIPAL'];
  // parseScopes drops unknown strings (a leftover 'disclose') and expands the
  // retired 'draft:write' bundle to register · steward · release.
  const scopes = parseScopes(process.env['CP_AUTHOR_SCOPES'] ?? 'register,steward,release');
  staticCredentials.push({ token, userId, kind, ...(principal ? { principal } : {}), scopes, label: 'environment (CP_AUTHOR_*)' });
} else if (token || userId) {
  throw new Error('CP_AUTHOR_TOKEN and CP_AUTHOR_USER_ID go together; set both or neither.');
}

// trustProxy: the ingress terminates TLS, and the Secure session cookie
// (§15.3) needs the original scheme from X-Forwarded-Proto.
const app = Fastify({ logger: true, trustProxy: true });
const pool = getPool();

await registerAuthoringRoutes(app, {
  pool,
  ownership: new PgOwnershipStore(pool),
  credentials: staticCredentials,
  credentialStore: {
    findByToken: (t) => findByToken(pool, t),
    touch: (id) => touch(pool, id),
  },
});
// Sign-in and /account (§15.3) mount only when the six CP_OAUTH_* /
// CP_SESSION_SECRET / CP_PUBLIC_ORIGIN variables are all present.
const identity = identityConfigFromEnv();
if (identity) await registerIdentityRoutes(app, { pool, config: identity });
await registerResolutionRoutes(app, { db: pool, html: process.env['RENDER_HTML'] !== 'false' });

app.log.info(
  staticCredentials.length > 0
    ? 'authoring: one environment credential plus the credential table'
    : 'authoring: credential table only (no CP_AUTHOR_* in the environment)',
);
app.log.info(identity ? `identity: sign-in with ${identity.providers.map((p) => p.name).join(' and ')} at ${identity.publicOrigin}` : 'identity: no sign-in (CP_OAUTH_* not set)');

const port = Number(process.env['CP_PORT'] ?? 8082);
const host = process.env['BIND_HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
