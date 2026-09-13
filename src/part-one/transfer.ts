/**
 * Transfer of a Top Level Prefix to another holder — design §8.4, operator
 * form (13 September 2026).
 *
 * §8.4 describes a voluntary transfer (two admins, a cooling window) and a
 * forced one (a steward panel). Neither exists yet. What Phase 1 needs is the
 * RELEASE of a grandfathered Prefix to its evident owner, which §10.2 ruling 4
 * promised "on verification" — an operator ruling in the mold of `allocate`:
 * evidence required, one audited transaction, nothing else touched.
 *
 * What changes: the allocation's holder. What does not: its status, class,
 * term and grandfathered flag; every published version beneath it (resolution
 * never consults governance state, §4.1 rule 1); anything about the previous
 * holder except that its members lose reach under the Prefix on their next
 * request, and its grants lapse — the seam honours a grant only while its
 * grantor is the current holder (§6.4).
 *
 * The destination organization must exist by exact name (or id) unless the
 * caller says `create: true`, so a misspelling refuses rather than quietly
 * conjuring a second organization and handing it a Prefix.
 */

import { record } from '../audit.ts';
import { isTlp } from '../names.ts';
import type { Queryable } from '../db.ts';
import type { ActorKind } from './types.ts';

export type TransferRequest = {
  tlp: string;
  /** Destination organization: exact name, or id. */
  to: string;
  /** Allow the destination to be created if no organization has that name. */
  create?: boolean;
  /** Only used when creating. */
  website?: string;
  contactEmail?: string;
  /** The §8.1 evidence — for a claimant without a web identity, the operator's attestation (Q9). */
  evidence: string;
  actor: { id: string; kind: ActorKind; principal?: string };
};

export type TransferRefusal = {
  transferred: false;
  code:
    | 'tlp.malformed'
    | 'allocation.not-found'
    | 'allocation.not-active'
    | 'organization.not-found'
    | 'organization.ambiguous'
    | 'organization.same-holder'
    | 'evidence.missing';
  message: string;
  details?: Record<string, unknown>;
};

export type TransferOutcome =
  | {
      transferred: true;
      tlp: string;
      allocationId: string;
      from: { id: string; name: string };
      to: { id: string; name: string; created: boolean };
    }
  | TransferRefusal;

function refuse(code: TransferRefusal['code'], message: string, details?: Record<string, unknown>): TransferRefusal {
  return { transferred: false, code, message, ...(details ? { details } : {}) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AllocationRow = { id: string; org_id: string; status: string; class: string; grandfathered: boolean; expires_at: string | null; holder: string };

/** Check everything, write nothing. */
export async function checkTransferable(
  db: Queryable,
  request: TransferRequest,
): Promise<{ refusal: TransferRefusal } | { refusal: null; allocation: AllocationRow; destination: { id: string; name: string } | null }> {
  if (!isTlp(request.tlp)) {
    return { refusal: refuse('tlp.malformed', 'A Top Level Prefix is a single lowercase segment (spec §7.2).') };
  }

  const found = await db.query<AllocationRow>(
    `SELECT a.id, a.org_id, a.status::text AS status, a.class::text AS class, a.grandfathered, a.expires_at, o.name AS holder
       FROM allocation a JOIN organization o ON o.id = a.org_id
      WHERE a.tlp = $1`,
    [request.tlp],
  );
  const allocation = found.rows[0];
  if (!allocation) {
    return { refusal: refuse('allocation.not-found', `"${request.tlp}" is not allocated; there is nothing to transfer.`) };
  }
  if (allocation.status !== 'active') {
    return {
      refusal: refuse(
        'allocation.not-active',
        `"${request.tlp}" is ${allocation.status}; only an active allocation transfers (§7.2: locked suspends transfer; redemption and released have nothing to transfer).`,
        { status: allocation.status },
      ),
    };
  }

  if (!request.evidence || request.evidence.trim().length < 20) {
    return {
      refusal: refuse(
        'evidence.missing',
        'A transfer ruling names its evidence — why this organization is the holder. Twenty characters is a low bar; clear it.',
      ),
    };
  }

  const orgs = await db.query<{ id: string; name: string }>(
    UUID.test(request.to)
      ? `SELECT id, name FROM organization WHERE id = $1 AND status <> 'dissolved'`
      : `SELECT id, name FROM organization WHERE name = $1 AND status <> 'dissolved'`,
    [request.to],
  );
  if (orgs.rows.length > 1) {
    return { refusal: refuse('organization.ambiguous', `More than one organization is named "${request.to}"; name it by id.`) };
  }
  const destination = orgs.rows[0] ?? null;
  if (!destination && !request.create) {
    return {
      refusal: refuse(
        'organization.not-found',
        `No organization is named "${request.to}". Pass --create if you mean to make one; otherwise check the spelling against the allocation pages.`,
      ),
    };
  }
  if (destination && destination.id === allocation.org_id) {
    return {
      refusal: refuse('organization.same-holder', `"${request.tlp}" is already held by ${destination.name}.`, { holder: destination.name }),
    };
  }

  return { refusal: null, allocation, destination };
}

/** Apply the ruling. Must be called on the client of an open transaction. */
export async function transferTlp(db: Queryable, request: TransferRequest): Promise<TransferOutcome> {
  const checked = await checkTransferable(db, request);
  if (checked.refusal) return checked.refusal;
  const { allocation } = checked;

  const auditActor = {
    actor: request.actor.id,
    actor_kind: request.actor.kind,
    ...(request.actor.principal ? { principal: request.actor.principal } : {}),
  } as const;

  let destination = checked.destination;
  let created = false;
  if (!destination) {
    const { rows } = await db.query<{ id: string; name: string }>(
      `INSERT INTO organization (name, website, contact_email, status, is_operator, verification)
       VALUES ($1, $2, $3, 'active', false, $4)
       RETURNING id, name`,
      [
        request.to,
        request.website ?? null,
        request.contactEmail ?? null,
        JSON.stringify({ method: 'operator-ruling', evidence: request.evidence, ruled_by: request.actor.principal ?? request.actor.id }),
      ],
    );
    destination = rows[0]!;
    created = true;
    await record(db, {
      ...auditActor,
      org_id: destination.id,
      action: 'organization.create',
      subject_type: 'organization',
      subject_id: destination.id,
      after: { name: destination.name, status: 'active' },
      rationale: `Created to receive "${request.tlp}". Evidence: ${request.evidence}`,
    });
  }

  await db.query(`UPDATE allocation SET org_id = $2, modified = now() WHERE id = $1`, [allocation.id, destination.id]);

  await record(db, {
    ...auditActor,
    org_id: destination.id,
    action: 'allocation.transfer',
    subject_type: 'allocation',
    subject_id: allocation.id,
    before: { tlp: request.tlp, holder: allocation.holder, org_id: allocation.org_id },
    after: {
      tlp: request.tlp,
      holder: destination.name,
      org_id: destination.id,
      status: allocation.status,
      class: allocation.class,
      grandfathered: allocation.grandfathered,
      expires_at: allocation.expires_at,
    },
    rationale: `Transfer under §8.4 (operator form). Evidence: ${request.evidence}`,
  });

  return {
    transferred: true,
    tlp: request.tlp,
    allocationId: allocation.id,
    from: { id: allocation.org_id, name: allocation.holder },
    to: { id: destination.id, name: destination.name, created },
  };
}
