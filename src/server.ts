/**
 * Part One entrypoint — `tlp.cnscp.io` (design §4.4).
 *
 * One of the four entrypoints §23 anticipates: allocation, authoring,
 * resolution, distribution. Only this one is built.
 */

import Fastify from 'fastify';
import { getPool } from './db.ts';
import { PgOwnershipStore } from './part-one/pg-store.ts';
import { registerPartOneRoutes } from './part-one/routes.ts';

const internalToken = process.env['INTERNAL_SEAM_TOKEN'];
if (!internalToken) {
  throw new Error(
    'INTERNAL_SEAM_TOKEN is not set. The seam (§9.3) authorizes writes and will not serve without it.',
  );
}

const app = Fastify({ logger: true });

// The POOL, not a checked-out client. A single client would serialise every
// query onto one connection and die with it, and would never be released.
// `pg.Pool` satisfies the same `query` interface, and acquires per statement.
const store = new PgOwnershipStore(getPool());
await registerPartOneRoutes(app, { store, internalToken });

const port = Number(process.env['PORT'] ?? 8081);

// Loopback by default. This host carries the seam, and binding an
// authorization service to every interface should be a deliberate act with a
// proxy in front of it, not what happens when nobody sets a variable.
const host = process.env['BIND_HOST'] ?? '127.0.0.1';

await app.listen({ port, host });
