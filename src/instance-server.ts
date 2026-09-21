/**
 * A local Registry instance — `cp.<organization>` (design §4.4, §20).
 *
 * The resolution server (src/resolution-server.ts) plus the follower: it
 * bootstraps from the authoritative host's snapshot, follows its journal,
 * verifies what it takes in, and serves the same resolution API from its own
 * database, byte-identical. This is what spec §7.4 means by "a conforming
 * Governor SHALL be able to operate from a local Registry instance".
 *
 * It writes nothing upstream and accepts no writes to the namespace: any
 * non-GET on a Registry path answers 405 with the authoritative host's URL,
 * and no authoring route exists to find.
 *
 * It MAY run a workspace beside the mirror (design §20.3): the organization's
 * own unpublished forms, held on the organization's own host, open to read
 * and written under the workspace credential — the one write surface an
 * instance can carry, and not a Registry surface. With none of the
 * WORKSPACE_* / CP_WORKSPACE_* variables set, none of it is mounted.
 *
 *   UPSTREAM_URL            https://cp.cnscp.io
 *   DATABASE_URL            this instance's own Postgres (migrated: npm run migrate,
 *                           plus npm run migrate:workspace when a workspace runs here)
 *   SYNC_INTERVAL_SECONDS   default 60; 0 to sync once at start and never again
 *   RESOLUTION_PORT         default 8080
 *   WORKSPACE_ORGS          organization ids whose held names the workspace may hold
 *   WORKSPACE_TEST          `true` to admit test.* forms (spec §7.1)
 *   CP_WORKSPACE_TOKEN      the workspace credential (or CP_WORKSPACE_TOKENS as label=token,…)
 *   CP_WORKSPACE_PRINCIPAL  the person answerable for saves
 */

import Fastify from 'fastify';
import { getPool } from './db.ts';
import { registerResolutionRoutes } from './part-three/routes.ts';
import { bootstrap, sync } from './distribution/follower.ts';
import { registerInstanceRefusals } from './distribution/routes.ts';
import { workspaceConfigFromEnv } from './workspace/config.ts';
import { workspaceCredentialsFromEnv } from './workspace/credential.ts';
import { createWorkspace } from './workspace/routes.ts';
import { holders, sweep } from './workspace/store.ts';

const upstream = (process.env['UPSTREAM_URL'] ?? '').replace(/\/+$/, '');
if (!upstream) throw new Error('UPSTREAM_URL is not set. An instance follows an authoritative host; name it.');

const workspaceConfig = workspaceConfigFromEnv();
const workspaceCredentials = workspaceCredentialsFromEnv();
if (workspaceConfig && workspaceCredentials.length === 0) {
  throw new Error('WORKSPACE_ORGS / WORKSPACE_TEST are set but no CP_WORKSPACE_TOKEN: a workspace nobody can write to is not one. Set the credential, or unset both.');
}
if (!workspaceConfig && workspaceCredentials.length > 0) {
  throw new Error('CP_WORKSPACE_TOKEN is set but the workspace holds nothing: set WORKSPACE_ORGS and/or WORKSPACE_TEST=true, or unset the credential.');
}

const pool = getPool();
const app = Fastify({ logger: true });

const first = await bootstrap(pool, upstream);
app.log.info(first.bootstrapped ? `bootstrapped from ${upstream} at seq ${first.head?.seq}` : `already bootstrapped; cursor at seq ${first.head?.seq}`);
const caughtUp = await sync(pool);
app.log.info(`journal at seq ${caughtUp.cursor.seq}; ${caughtUp.applied} act(s) applied`);

const html = process.env['RENDER_HTML'] !== 'false';
const workspace = workspaceConfig
  ? createWorkspace({ db: pool, config: workspaceConfig, credentials: workspaceCredentials, upstream, html })
  : null;

if (workspaceConfig) {
  for (const org of await holders(pool, workspaceConfig)) {
    if (org.name) app.log.info(`workspace: holding forms for names held by "${org.name}" (${org.id})`);
    else app.log.warn(`workspace: organization ${org.id} is not in this instance's mirror yet; its names cannot qualify until it is`);
  }
  if (workspaceConfig.test) app.log.info('workspace: admitting test.* forms (spec §7.1)');
  const swept = await sweep(pool, workspaceConfig);
  if (swept.length > 0) app.log.info(`workspace: swept ${swept.length} form(s) whose names no longer qualify: ${swept.join(', ')}`);
}

await registerResolutionRoutes(app, {
  db: pool,
  html,
  role: 'instance',
  upstream,
  ...(workspace ? { workspace: workspace.hooks } : {}),
});

workspace?.register(app);
registerInstanceRefusals(app, upstream);

const interval = Number(process.env['SYNC_INTERVAL_SECONDS'] ?? 60);
if (interval > 0) {
  const timer = setInterval(() => {
    sync(pool)
      .then(async () => {
        // A released or transferred name's form goes dark on the next read
        // regardless; the sweep is what removes the row (§20.3).
        if (!workspaceConfig) return;
        const swept = await sweep(pool, workspaceConfig);
        if (swept.length > 0) app.log.info(`workspace: swept ${swept.join(', ')}`);
      })
      .catch((error) => app.log.error(error, 'sync failed; the cursor did not move'));
  }, interval * 1000);
  timer.unref();
}

const port = Number(process.env['RESOLUTION_PORT'] ?? 8080);
const host = process.env['BIND_HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
