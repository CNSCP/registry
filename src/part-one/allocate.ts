/**
 * Allocation of a new Top Level Prefix — the first §9.2 operator act.
 *
 * Phase 2 owns the full §8 machinery: applications, verification challenges,
 * reviewer queues. What exists here is the Phase 0 form of the same act — an
 * OPERATOR RULING, exactly as the §10.2 bootstrap was: the operator decides,
 * the decision names its evidence, and every row it creates carries an audit
 * event in the same transaction (§4.3).
 *
 * The act is deliberately narrow. It creates an organization (or reuses one),
 * one allocation row, and optionally one day-one membership so somebody can
 * act under the Prefix — because an allocation with no member and no
 * authorization record satisfies `authorizes()` for nobody, and a Prefix
 * nobody can write under is a plausible-looking mistake.
 *
 * What it does NOT do: touch an existing allocation (transfers, releases and
 * redemption are Phase 2), or override policy — `availability()` is consulted
 * and its refusals are final here. Releasing a withheld Prefix is a different
 * recorded decision, not a parameter of this one.
 */

import { record } from '../audit.ts';
import { availability } from '../policy.ts';
import { isTlp } from '../names.ts';
import type { Queryable } from '../db.ts';
import type { ActorKind } from './types.ts';

export type AllocateRequest = {
  tlp: string;
  organization: {
    name: string;
    website?: string;
    contactEmail?: string;
  };
  /**
   * The §8.1 evidence the ruling rests on — e.g. "operator verified that
   * Cimetrics Inc. controls cimetrics.com". Recorded on the organization and
   * in the audit chain; a ruling without evidence is not a ruling.
   */
  evidence: string;
  /** §8.2 renewable term, in years. Recorded as expires_at (enforcement is §25 Q8). */
  termYears?: number;
  /** Published on the allocation page (§19.3). */
  notes?: string;
  /** Day-one actor: this app_user becomes an admin member of the holder org. */
  memberUserId?: string;
  /** The operator credential performing the act, for the audit chain (§4.3). */
  actor: { id: string; kind: ActorKind; principal?: string };
};

export type AllocateRefusal = {
  allocated: false;
  code:
    | 'tlp.malformed'
    | 'tlp.unavailable'
    | 'tlp.already-allocated'
    | 'evidence.missing'
    | 'organization.ambiguous'
    | 'member.unknown';
  message: string;
  details?: Record<string, unknown>;
};

export type AllocateOutcome =
  | {
      allocated: true;
      tlp: string;
      allocationId: string;
      expiresAt: string | null;
      organization: { id: string; name: string; created: boolean };
      membership: { userId: string; role: 'admin' } | null;
    }
  | AllocateRefusal;

function refuse(code: AllocateRefusal['code'], message: string, details?: Record<string, unknown>): AllocateRefusal {
  return { allocated: false, code, message, ...(details ? { details } : {}) };
}

/**
 * Check everything, write nothing. The dry run and the real act share this,
 * so a plan that survives rehearsal is the plan that executes.
 */
export async function checkAllocatable(db: Queryable, request: AllocateRequest): Promise<AllocateRefusal | null> {
  if (!isTlp(request.tlp)) {
    return refuse('tlp.malformed', 'A Top Level Prefix is a single lowercase segment (spec §7.2).');
  }

  const policy = availability(request.tlp);
  if (!policy.available) {
    // Spec-reserved is nobody's to allocate; withheld and restricted are the
    // operator's own published policy, and overriding policy in the same act
    // that applies it would make the published lists meaningless.
    return refuse('tlp.unavailable', `"${request.tlp}" is not allocatable: ${policy.because} (§3.2).`, { policy });
  }

  const existing = await db.query<{ id: string; holder: string | null }>(
    `SELECT a.id, o.name AS holder
       FROM allocation a
       LEFT JOIN organization o ON o.id = a.org_id
      WHERE a.tlp = $1`,
    [request.tlp],
  );
  if (existing.rows[0]) {
    return refuse(
      'tlp.already-allocated',
      `"${request.tlp}" is already allocated (spec §7.1: one holder at a time). Transfers are Phase 2.`,
      { holder: existing.rows[0].holder },
    );
  }

  if (!request.evidence || request.evidence.trim().length < 20) {
    return refuse(
      'evidence.missing',
      'An allocation ruling names its §8.1 evidence — what was verified, and how. Twenty characters is a low bar; clear it.',
    );
  }

  const orgs = await db.query<{ id: string }>(
    `SELECT id FROM organization WHERE name = $1 AND status <> 'dissolved'`,
    [request.organization.name],
  );
  if (orgs.rows.length > 1) {
    return refuse(
      'organization.ambiguous',
      `More than one organization is named "${request.organization.name}"; the ruling must name exactly one.`,
    );
  }

  if (request.memberUserId) {
    const user = await db.query(`SELECT id FROM app_user WHERE id = $1`, [request.memberUserId]);
    if (user.rows.length === 0) {
      return refuse('member.unknown', `No app_user with id "${request.memberUserId}".`, {
        member_user_id: request.memberUserId,
      });
    }
  }

  return null;
}

/** Apply the ruling. Must be called on the client of an open transaction. */
export async function allocateTlp(db: Queryable, request: AllocateRequest): Promise<AllocateOutcome> {
  const refusal = await checkAllocatable(db, request);
  if (refusal) return refusal;

  const auditActor = {
    actor: request.actor.id,
    actor_kind: request.actor.kind,
    ...(request.actor.principal ? { principal: request.actor.principal } : {}),
  } as const;

  // The organization: reuse an exact-name match, create otherwise. A created
  // org is 'active' immediately — the operator's ruling IS its verification,
  // and the evidence says of what.
  const existingOrg = await db.query<{ id: string }>(
    `SELECT id FROM organization WHERE name = $1 AND status <> 'dissolved'`,
    [request.organization.name],
  );

  let orgId: string;
  let orgCreated = false;
  if (existingOrg.rows[0]) {
    orgId = existingOrg.rows[0].id;
  } else {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO organization (name, website, contact_email, status, is_operator, verification)
       VALUES ($1, $2, $3, 'active', false, $4)
       RETURNING id`,
      [
        request.organization.name,
        request.organization.website ?? null,
        request.organization.contactEmail ?? null,
        JSON.stringify({
          method: 'operator-ruling',
          evidence: request.evidence,
          ruled_by: request.actor.principal ?? request.actor.id,
        }),
      ],
    );
    orgId = rows[0]!.id;
    orgCreated = true;

    await record(db, {
      ...auditActor,
      org_id: orgId,
      action: 'organization.create',
      subject_type: 'organization',
      subject_id: orgId,
      after: { name: request.organization.name, status: 'active' },
      rationale: `Created for the allocation of "${request.tlp}". Evidence: ${request.evidence}`,
    });
  }

  const { rows: allocationRows } = await db.query<{ id: string; expires_at: string | null }>(
    `INSERT INTO allocation (tlp, org_id, status, class, allocated_at, grandfathered, expires_at, notes)
     VALUES ($1, $2, 'active', 'standard', now(), false,
             CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(years => $3::int) END,
             $4)
     RETURNING id, expires_at`,
    [request.tlp, orgId, request.termYears ?? null, request.notes ?? null],
  );
  const allocation = allocationRows[0]!;

  await record(db, {
    ...auditActor,
    org_id: orgId,
    action: 'allocation.create',
    subject_type: 'allocation',
    subject_id: allocation.id,
    after: {
      tlp: request.tlp,
      holder: request.organization.name,
      status: 'active',
      class: 'standard',
      grandfathered: false,
      expires_at: allocation.expires_at,
    },
    rationale: `Operator ruling under spec §8 (Phase 0 form). Evidence: ${request.evidence}`,
  });

  let membership: { userId: string; role: 'admin' } | null = null;
  if (request.memberUserId) {
    await db.query(
      `INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT ON CONSTRAINT member_unique_per_org DO NOTHING`,
      [orgId, request.memberUserId],
    );
    membership = { userId: request.memberUserId, role: 'admin' };

    await record(db, {
      ...auditActor,
      org_id: orgId,
      action: 'member.add',
      subject_type: 'member',
      subject_id: request.memberUserId,
      after: { org_id: orgId, user_id: request.memberUserId, role: 'admin' },
      rationale: `Day-one actor for "${request.tlp}": an allocation nobody can write under is a mistake, not a holding.`,
    });
  }

  return {
    allocated: true,
    tlp: request.tlp,
    allocationId: allocation.id,
    expiresAt: allocation.expires_at,
    organization: { id: orgId, name: request.organization.name, created: orgCreated },
    membership,
  };
}
