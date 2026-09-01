/**
 * Part Three entrypoint — `cp.cnscp.io` (design §4.4, §19).
 *
 * Serves the RESOLUTION PROFILE of the host contract: every GET of §19, and
 * nothing else. This is what spec §7.4 requires a Governor be able to run
 * locally, and what §20 distributes — so `cp.<organization>` runs this exact
 * process against a read replica or a local copy.
 *
 * Nothing here writes. There is no authoring, no console, and no operator
 * plane: a write to a local instance returns the authoritative host's URL, and
 * the absence of the verbs is the enforcement (§4.4).
 *
 * NO CREDENTIALS ON THIS PATH. §4.4: session cookies are scoped to /console and
 * are neither sent to nor honoured on resolution paths, so a credential can
 * never enter a cache key. Resolution answers "without regard to the identity
 * of the party presenting a name" (spec §9.3).
 */

import Fastify from 'fastify';
import { getPool } from './db.ts';
import { registerResolutionRoutes } from './part-three/routes.ts';

const app = Fastify({ logger: true });

// The pool, not a checked-out client: resolution is the read path and scales
// on read replicas (§23).
await registerResolutionRoutes(app, {
  db: getPool(),
  // HTML is a courtesy; a JSON-only instance is fully conforming (§19.1).
  html: process.env['RENDER_HTML'] !== 'false',
});

const port = Number(process.env['RESOLUTION_PORT'] ?? 8080);
const host = process.env['BIND_HOST'] ?? '127.0.0.1';

await app.listen({ port, host });
