/**
 * The bootstrap loader — design §10.2.
 *
 * Idempotent and audited. Every allocation created here carries an audit event
 * naming the ruling that put it there, written in the same transaction as the
 * insert (§4.3).
 *
 * Kept apart from `run.ts` so it takes a database handle rather than reaching
 * for a global pool — which is what makes it testable against a real Postgres.
 */

import { record } from '../audit.ts';
import { isSpecReserved, WITHHELD } from '../policy.ts';
import { assertTlp } from '../names.ts';
import { GRANDFATHERED, OPERATOR_ORG } from './grandfathered.ts';
import type { Queryable } from '../db.ts';

export const SEED_ACTOR = 'seed:bootstrap';

export type PlannedAllocation = {
  tlp: string;
  disposition: 'operator' | 'pending-claimant' | 'withheld';
  records: number;
  evidentAuthor: string;
  pendingClaimant: string | null;
  closedToRegistration: boolean;
  rationale: string;
};

export type Plan = {
  observed: PlannedAllocation[];
  /** Withheld Prefixes that hold no records and so are not in the inventory. */
  infrastructure: PlannedAllocation[];
  all: PlannedAllocation[];
  /** Spec-reserved: named for the record, never inserted. */
  reserved: string[];
};

/**
 * Build the plan, checking the invariants that a hand-edited seed file could
 * break. Pure — no database, so the tests can assert on it directly.
 */
export function buildPlan(): Plan {
  for (const prefix of GRANDFATHERED) {
    assertTlp(prefix.tlp);
    if ((prefix.disposition === 'spec-reserved') !== isSpecReserved(prefix.tlp)) {
      throw new Error(
        `seed: "${prefix.tlp}" is marked ${prefix.disposition} but policy.ts ${
          isSpecReserved(prefix.tlp) ? 'reserves it' : 'does not reserve it'
        }`,
      );
    }
  }

  const observed: PlannedAllocation[] = GRANDFATHERED.filter(
    (p) => p.disposition !== 'spec-reserved',
  ).map((p) => ({
    tlp: p.tlp,
    disposition: p.disposition as PlannedAllocation['disposition'],
    records: p.records,
    evidentAuthor: p.evidentAuthor,
    pendingClaimant: p.pendingClaimant ?? null,
    closedToRegistration: p.closedToRegistration ?? false,
    rationale: p.rationale,
  }));

  // §3.2 says a withheld Prefix "is held by the operator, so nothing beneath it
  // is ownerless", and `authorizes()` reasons from exactly that — it declines
  // to refuse on the withheld list because a withheld Prefix is supposed to
  // have a real allocation row. The infrastructure and path-shadowing entries
  // hold no records today and so are absent from the inventory; seed them
  // anyway, or the stated invariant is simply false.
  const infrastructure: PlannedAllocation[] = WITHHELD.filter(
    (w) => !GRANDFATHERED.some((p) => p.tlp === w.tlp),
  ).map((w) => ({
    tlp: w.tlp,
    disposition: 'withheld',
    records: 0,
    evidentAuthor: 'none',
    pendingClaimant: null,
    closedToRegistration: true,
    rationale: w.rationale,
  }));

  return {
    observed,
    infrastructure,
    all: [...observed, ...infrastructure],
    reserved: GRANDFATHERED.filter((p) => p.disposition === 'spec-reserved').map((p) => p.tlp),
  };
}

export async function operatorOrgId(db: Queryable): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM organization WHERE is_operator LIMIT 1`,
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO organization (name, website, contact_email, status, is_operator, verification)
     VALUES ($1, $2, $3, 'active', true, $4)
     RETURNING id`,
    [
      OPERATOR_ORG.name,
      OPERATOR_ORG.website,
      OPERATOR_ORG.contactEmail,
      JSON.stringify({
        method: 'operator',
        note: 'The operator organization, established at bootstrap. Not subject to §8.1 verification.',
      }),
    ],
  );

  const row = rows[0];
  if (!row) throw new Error('failed to create the operator organization');

  await record(db, {
    actor: SEED_ACTOR,
    actor_kind: 'operator',
    principal: OPERATOR_ORG.contactEmail,
    org_id: row.id,
    action: 'organization.create',
    subject_type: 'organization',
    subject_id: row.id,
    after: { name: OPERATOR_ORG.name, is_operator: true, status: 'active' },
    rationale: 'Operator organization, established at bootstrap (§10.2).',
  });

  return row.id;
}

export type SeedResult = { created: number; skipped: number; orgId: string };

/** Apply the plan. Must be called on the client of an open transaction. */
export async function applySeed(db: Queryable, plan: Plan = buildPlan()): Promise<SeedResult> {
  const orgId = await operatorOrgId(db);
  let created = 0;
  let skipped = 0;

  for (const prefix of plan.all) {
    const existing = await db.query(`SELECT id FROM allocation WHERE tlp = $1`, [prefix.tlp]);
    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    const allocationClass = prefix.disposition === 'withheld' ? 'reserved' : 'operator';
    // "Allocated before the specification took effect" (spec §7.1) — true of
    // the observed holdings, false of an infrastructure Prefix nobody ever used.
    const grandfathered = prefix.records > 0;

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO allocation
         (tlp, org_id, status, class, allocated_at, grandfathered,
          pending_claimant, closed_to_registration, notes)
       VALUES ($1, $2, 'active', $3, now(), $4, $5, $6, $7)
       RETURNING id`,
      [
        prefix.tlp,
        orgId,
        allocationClass,
        grandfathered,
        prefix.pendingClaimant,
        prefix.closedToRegistration,
        prefix.rationale,
      ],
    );

    const allocation = rows[0];
    if (!allocation) throw new Error(`failed to insert allocation for "${prefix.tlp}"`);

    await record(db, {
      actor: SEED_ACTOR,
      actor_kind: 'operator',
      principal: OPERATOR_ORG.contactEmail,
      org_id: orgId,
      action: 'allocation.grandfather',
      subject_type: 'allocation',
      subject_id: allocation.id,
      // Must describe what was actually written. An audit record that disagrees
      // with the row it records is worse than none.
      after: {
        tlp: prefix.tlp,
        disposition: prefix.disposition,
        class: allocationClass,
        grandfathered,
        pending_claimant: prefix.pendingClaimant,
        closed_to_registration: prefix.closedToRegistration,
        records_observed: prefix.records,
        evident_author: prefix.evidentAuthor,
      },
      rationale: prefix.rationale,
    });

    created++;
  }

  return { created, skipped, orgId };
}
