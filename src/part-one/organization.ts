/**
 * Organization acts on the §9.2 operator plane. One so far: rename.
 *
 * A rename changes the display name — what every allocation page shows as
 * "Held by …" — and nothing else. Memberships, holdings, grants and the
 * organization's id are untouched, so every journal entry ever written still
 * refers to the same row. Public in the journal, because the holder's name is
 * a public fact a local instance must follow.
 */

import { record } from '../audit.ts';
import type { Queryable } from '../db.ts';
import type { ActorKind } from './types.ts';

export type RenameRequest = {
  /** Exact current name, or id. */
  org: string;
  to: string;
  actor: { id: string; kind: ActorKind; principal?: string };
};

export type RenameOutcome =
  | { renamed: true; id: string; from: string; to: string }
  | { renamed: false; code: 'organization.not-found' | 'organization.ambiguous' | 'name.taken' | 'name.empty'; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function renameOrganization(db: Queryable, request: RenameRequest): Promise<RenameOutcome> {
  const to = request.to.trim();
  if (!to) return { renamed: false, code: 'name.empty', message: 'An organization needs a name.' };

  const found = await db.query<{ id: string; name: string }>(
    UUID.test(request.org)
      ? `SELECT id, name FROM organization WHERE id = $1 AND status <> 'dissolved'`
      : `SELECT id, name FROM organization WHERE name = $1 AND status <> 'dissolved'`,
    [request.org],
  );
  if (found.rows.length > 1) return { renamed: false, code: 'organization.ambiguous', message: `More than one organization is named "${request.org}"; name it by id.` };
  const org = found.rows[0];
  if (!org) return { renamed: false, code: 'organization.not-found', message: `No organization is named "${request.org}".` };

  const taken = await db.query(`SELECT 1 FROM organization WHERE name = $1 AND id <> $2 AND status <> 'dissolved'`, [to, org.id]);
  if (taken.rows.length > 0) return { renamed: false, code: 'name.taken', message: `"${to}" is already an organization's name.` };

  await db.query(`UPDATE organization SET name = $2, modified = now() WHERE id = $1`, [org.id, to]);
  await record(db, {
    actor: request.actor.id,
    actor_kind: request.actor.kind,
    ...(request.actor.principal ? { principal: request.actor.principal } : {}),
    org_id: org.id,
    action: 'organization.rename',
    subject_type: 'organization',
    subject_id: org.id,
    before: { name: org.name },
    after: { name: to },
    rationale: `Renamed by the operator: "${org.name}" → "${to}".`,
  });
  return { renamed: true, id: org.id, from: org.name, to };
}
