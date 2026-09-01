/**
 * Run the Phase 0 import into the database — design §10.4.
 *
 * Takes the plan `src/profile/import.ts` produces and writes it: registers the
 * names, publishes the versions, records the shortfalls. Idempotent, and every
 * act lands in the audit chain in the same transaction as the row it creates.
 *
 * The importer authors nothing. Where the source had no Owner, the version is
 * published without one and the gap is recorded in `missing_header_fields`,
 * which the version's page publishes. §12.2 freezes content at publication and
 * §9.3 forbids ever altering it, so a plausible-looking substitute inserted
 * here would be permanent.
 */

import type { Queryable } from '../db.ts';
import type { Profile } from '../profile/model.ts';
import { planImport, type ImportPlan } from '../profile/import.ts';
import { registerName, publishVersion, type Actor } from '../profile/store.ts';
import { tlpOf } from '../names.ts';

export const IMPORT_ACTOR: Actor = {
  actor: 'seed:import-cp-padi-io',
  kind: 'operator',
  principal: 'registry@padi.io',
};

export type ImportResult = {
  namesRegistered: number;
  namesSkipped: number;
  versionsPublished: number;
  excluded: number;
  withoutVersions: number;
  nonConforming: number;
};

/**
 * Resolve each name's Prefix to its allocation.
 *
 * §12.1 makes `allocation_id` the owner chain root, and the seed (§10.2) has
 * already created every allocation these names sit under. A missing one is a
 * bug in the seed, not something to paper over with a null.
 */
async function allocationsByTlp(db: Queryable): Promise<Map<string, string>> {
  const { rows } = await db.query<{ tlp: string; id: string }>(`SELECT tlp, id FROM allocation`);
  return new Map(rows.map((r) => [r.tlp, r.id]));
}

export async function runImport(
  db: Queryable,
  corpus: Profile[],
  plan: ImportPlan = planImport(corpus),
): Promise<ImportResult> {
  const allocations = await allocationsByTlp(db);

  const result: ImportResult = {
    namesRegistered: 0,
    namesSkipped: 0,
    versionsPublished: 0,
    excluded: plan.excluded.length,
    withoutVersions: plan.registeredWithoutVersions.length,
    nonConforming: plan.nonConforming,
  };

  // Group the planned versions by the name they will be published under, so a
  // name is registered once and its versions published in order.
  const versionsByName = new Map<string, typeof plan.imported>();
  for (const version of plan.imported) {
    const list = versionsByName.get(version.name) ?? [];
    list.push(version);
    versionsByName.set(version.name, list);
  }

  for (const name of plan.registeredNames) {
    const tlp = tlpOf(name);
    const allocationId = allocations.get(tlp);
    if (!allocationId) {
      throw new Error(
        `import: no allocation for Prefix "${tlp}" (name "${name}"). Run the bootstrap seed first.`,
      );
    }

    const existing = await db.query<{ id: string }>(`SELECT id FROM profile WHERE name = $1`, [name]);
    let profileId = existing.rows[0]?.id;

    if (profileId) {
      result.namesSkipped++;
    } else {
      const versions = versionsByName.get(name) ?? [];
      const first = versions[0];
      // Registration date: the source's own `created`, so the public fact spec
      // §7.3 exposes is the real one rather than the date of this import.
      const registeredAt = first?.profile.created ? new Date(first.profile.created) : undefined;
      const importedFrom = first && first.sourceName !== name ? first.sourceName : undefined;

      const registered = await registerName(db, IMPORT_ACTOR, {
        name,
        allocationId,
        ...(registeredAt ? { registeredAt } : {}),
        ...(importedFrom ? { importedFrom } : {}),
      });
      profileId = registered.id;
      result.namesRegistered++;
    }

    // Publish in version order. Skipped entirely if the name already had
    // versions, which is what makes a second run a no-op.
    const published = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile_version WHERE profile_id = $1`,
      [profileId],
    );
    if (Number(published.rows[0]?.n ?? '0') > 0) continue;

    for (const version of (versionsByName.get(name) ?? []).sort((a, b) => a.version - b.version)) {
      await publishVersion(db, IMPORT_ACTOR, {
        profileId,
        name,
        profile: version.profile,
        content: version.content,
        ...(version.profile.pubDate ? { publishedAt: new Date(version.profile.pubDate) } : {}),
        grandfathered: true,
        pubDateApproximate: version.pubDateIsApproximate,
        missingHeaderFields: version.missingHeaderFields,
        rationale: version.conforms
          ? 'Grandfathered import from cp.padi.io (§10.4).'
          : `Grandfathered import from cp.padi.io (§10.4). Does not meet §9.4: missing REQUIRED Header field(s) ${version.missingHeaderFields.join(', ')}. Recorded rather than filled — the Registry does not author what it imports.`,
      });
      result.versionsPublished++;
    }
  }

  return result;
}
