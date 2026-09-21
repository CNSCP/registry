/**
 * The workspace's configuration, from the environment — design §20.3.
 *
 *   WORKSPACE_ORGS   comma-separated organization ids whose held names this
 *                    workspace may hold forms for (ids, not names: stable
 *                    across the §8.4 rename act)
 *   WORKSPACE_TEST   `true` to admit `test.*` forms (spec §7.1). Off unless
 *                    set: the software cannot tell a private host from a
 *                    public one, so a public host serving test.* at a public
 *                    URL is a choice someone made, not a default they got.
 *
 * With neither set, the host runs no workspace and is the instance of §20.1
 * exactly as before.
 */

import type { WorkspaceConfig } from './store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workspaceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceConfig | null {
  const orgs = (env['WORKSPACE_ORGS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const test = /^(true|1|yes)$/i.test((env['WORKSPACE_TEST'] ?? '').trim());
  if (orgs.length === 0 && !test) return null;
  for (const id of orgs) {
    if (!UUID.test(id)) throw new Error(`WORKSPACE_ORGS: "${id}" is not an organization id (a UUID, as the allocation page and the snapshot give it)`);
  }
  return { orgs, test };
}
