/**
 * A local Registry instance — `cp.<organization>` (design §4.4, §20).
 *
 * The resolution server (src/resolution-server.ts) plus the follower: it
 * bootstraps from the authoritative host's snapshot, follows its journal,
 * verifies what it takes in, and serves the same resolution API from its own
 * database, byte-identical. This is what spec §7.4 means by "a conforming
 * Governor SHALL be able to operate from a local Registry instance".
 *
 * It writes nothing upstream and accepts no writes: any non-GET answers 405
 * with the authoritative host's URL, and no authoring route exists to find.
 *
 *   UPSTREAM_URL            https://cp.cnscp.io
 *   DATABASE_URL            this instance's own Postgres (migrated: npm run migrate)
 *   SYNC_INTERVAL_SECONDS   default 60; 0 to sync once at start and never again
 *   RESOLUTION_PORT         default 8080
 */

import Fastify from 'fastify';
import { getPool } from './db.ts';
import { registerResolutionRoutes } from './part-three/routes.ts';
import { bootstrap, sync } from './distribution/follower.ts';
import { registerInstanceRefusals } from './distribution/routes.ts';

const upstream = (process.env['UPSTREAM_URL'] ?? '').replace(/\/+$/, '');
if (!upstream) throw new Error('UPSTREAM_URL is not set. An instance follows an authoritative host; name it.');

const pool = getPool();
const app = Fastify({ logger: true });

const first = await bootstrap(pool, upstream);
app.log.info(first.bootstrapped ? `bootstrapped from ${upstream} at seq ${first.head?.seq}` : `already bootstrapped; cursor at seq ${first.head?.seq}`);
const caughtUp = await sync(pool);
app.log.info(`journal at seq ${caughtUp.cursor.seq}; ${caughtUp.applied} act(s) applied`);

await registerResolutionRoutes(app, {
  db: pool,
  html: process.env['RENDER_HTML'] !== 'false',
  role: 'instance',
  upstream,
});

registerInstanceRefusals(app, upstream);

const interval = Number(process.env['SYNC_INTERVAL_SECONDS'] ?? 60);
if (interval > 0) {
  const timer = setInterval(() => {
    sync(pool).catch((error) => app.log.error(error, 'sync failed; the cursor did not move'));
  }, interval * 1000);
  timer.unref();
}

const port = Number(process.env['RESOLUTION_PORT'] ?? 8080);
const host = process.env['BIND_HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
