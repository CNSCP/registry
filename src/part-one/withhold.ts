/**
 * Taking custody of a withheld Prefix — design §3.2, §8.4 (operator form).
 *
 * §3.2 says a withheld Prefix "is held by the operator, so nothing beneath it
 * is ownerless", and `authorizes()` reasons from exactly that: it does not
 * refuse on the withheld list, because a withheld Prefix is supposed to have a
 * real allocation row behind it. The Phase 0 seed made that true for every
 * entry on the list AT THE TIME IT RAN (`allocation.grandfather`, one-time,
 * answered to followers by the snapshot). Anything added to the list
 * afterwards has no row, and the stated invariant is quietly false for it —
 * which is what happened to `account` and `auth` when §15.3 reserved their
 * paths on 12 September 2026.
 *
 * This is the act that closes that gap, and it is deliberately narrow:
 *
 *   - It allocates ONLY to the operator organization. Custody, not a holding
 *     someone bargained for.
 *   - It allocates ONLY a Prefix that the operator's own published policy
 *     already withholds, and only in the two classes that mean "infrastructure
 *     the Registry needs" — `infrastructure` and `path-shadowing`. A
 *     `documentary` or `operator-held` entry is already in the seed inventory;
 *     an available Prefix goes through `allocateTlp` with evidence, like
 *     anybody else's.
 *   - It never touches a spec-reserved Prefix. Those are nobody's to allocate,
 *     including the operator's (spec §7.1).
 *
 * There is no `--evidence` because the published policy entry IS the evidence:
 * the rule's own class and rationale are what the audit event records. That is
 * the difference between this and an allocation ruling, where evidence is a
 * fact about the world that only the operator has seen.
 *
 * The event is `allocation.create`, which is public (§20.1). The seed's
 * `allocation.grandfather` is not, and correctly so: bootstrap was a single
 * load that every follower receives whole in the snapshot. A row created now
 * arrives after followers exist, so the journal is the only way they learn of
 * it — and who holds a Prefix is exactly what §7.4 says third parties must be
 * able to see.
 */

import { record } from '../audit.ts';
import { availability, WITHHELD, type WithheldClass } from '../policy.ts';
import { isTlp } from '../names.ts';
import type { Queryable } from '../db.ts';
import type { ActorKind } from './types.ts';

/** The classes this act may take custody of. The other two are seed inventory. */
const CUSTODIAL: readonly WithheldClass[] = ['infrastructure', 'path-shadowing'] as const;

export type WithholdRequest = {
  tlp: string;
  actor: { id: string; kind: ActorKind; principal?: string };
};

export type WithholdRefusal = {
  withheld: false;
  code:
    | 'tlp.malformed'
    | 'tlp.spec-reserved'
    | 'tlp.not-withheld'
    | 'tlp.not-custodial'
    | 'tlp.already-allocated'
    | 'operator.missing';
  message: string;
  details?: Record<string, unknown>;
};

export type WithholdOutcome =
  | {
      withheld: true;
      tlp: string;
      allocationId: string;
      class: WithheldClass;
      holder: { id: string; name: string };
    }
  | WithholdRefusal;

function refuse(code: WithholdRefusal['code'], message: string, details?: Record<string, unknown>): WithholdRefusal {
  return { withheld: false, code, message, ...(details ? { details } : {}) };
}

/** Check everything, write nothing — shared with the dry run and with `--all`. */
export async function checkWithholdable(db: Queryable, tlp: string): Promise<WithholdRefusal | null> {
  if (!isTlp(tlp)) {
    return refuse('tlp.malformed', 'A Top Level Prefix is a single lowercase segment (spec §7.2).');
  }

  const policy = availability(tlp);
  if (policy.available) {
    return refuse(
      'tlp.not-withheld',
      `"${tlp}" is not withheld by policy, so there is nothing to take custody of. An ordinary allocation names its evidence: use \`allocation allocate\`.`,
    );
  }
  if (policy.because === 'spec-reserved') {
    return refuse(
      'tlp.spec-reserved',
      `"${tlp}" is reserved by the specification and SHALL NOT be allocated, by anyone, including the operator (spec §7.1).`,
      { rule: policy.rule },
    );
  }
  if (policy.because === 'restricted') {
    return refuse(
      'tlp.not-withheld',
      `"${tlp}" is restricted, not withheld: allocatable on reviewer approval with recorded rationale (§8.2), not by custody.`,
    );
  }
  if (!CUSTODIAL.includes(policy.class)) {
    return refuse(
      'tlp.not-custodial',
      `"${tlp}" is withheld as ${policy.class}, which is a holding the seed already records, not infrastructure this act may take.`,
      { class: policy.class },
    );
  }

  const existing = await db.query<{ holder: string | null }>(
    `SELECT o.name AS holder
       FROM allocation a
       LEFT JOIN organization o ON o.id = a.org_id
      WHERE a.tlp = $1`,
    [tlp],
  );
  if (existing.rows[0]) {
    return refuse('tlp.already-allocated', `"${tlp}" is already allocated (spec §7.1: one holder at a time).`, {
      holder: existing.rows[0].holder,
    });
  }

  const operator = await db.query(`SELECT id FROM organization WHERE is_operator AND status <> 'dissolved'`);
  if (operator.rows.length === 0) {
    return refuse('operator.missing', 'No operator organization exists; run the seed before taking custody of anything.');
  }

  return null;
}

/** Apply it. Must be called on the client of an open transaction. */
export async function withholdTlp(db: Queryable, request: WithholdRequest): Promise<WithholdOutcome> {
  const refusal = await checkWithholdable(db, request.tlp);
  if (refusal) return refusal;

  const rule = WITHHELD.find((w) => w.tlp === request.tlp)!;

  const { rows: orgRows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM organization WHERE is_operator AND status <> 'dissolved' LIMIT 1`,
  );
  const operator = orgRows[0]!;

  // class 'reserved', matching what the seed writes for a withheld Prefix:
  // held so that nothing beneath it is ownerless, not offered to anyone.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO allocation (tlp, org_id, status, class, allocated_at, grandfathered, expires_at, notes)
     VALUES ($1, $2, 'active', 'reserved', now(), false, NULL, $3)
     RETURNING id`,
    [request.tlp, operator.id, rule.rationale],
  );
  const allocation = rows[0]!;

  await record(db, {
    actor: request.actor.id,
    actor_kind: request.actor.kind,
    ...(request.actor.principal ? { principal: request.actor.principal } : {}),
    org_id: operator.id,
    action: 'allocation.create',
    subject_type: 'allocation',
    subject_id: allocation.id,
    after: {
      tlp: request.tlp,
      holder: operator.name,
      status: 'active',
      class: 'reserved',
      grandfathered: false,
      expires_at: null,
    },
    rationale: `Withheld by operator policy as ${rule.class} (§3.2): ${rule.rationale}`,
  });

  return {
    withheld: true,
    tlp: request.tlp,
    allocationId: allocation.id,
    class: rule.class,
    holder: { id: operator.id, name: operator.name },
  };
}

/**
 * Every withheld Prefix this act is responsible for that has no allocation
 * row — the list `--all` works through, and the invariant the test asserts.
 */
export async function custodyGaps(db: Queryable): Promise<string[]> {
  const candidates = WITHHELD.filter((w) => CUSTODIAL.includes(w.class)).map((w) => w.tlp);
  if (candidates.length === 0) return [];
  const { rows } = await db.query<{ tlp: string }>(`SELECT tlp FROM allocation WHERE tlp = ANY($1::text[])`, [
    candidates,
  ]);
  const held = new Set(rows.map((r) => r.tlp));
  return candidates.filter((tlp) => !held.has(tlp));
}
