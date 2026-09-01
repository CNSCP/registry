/**
 * Postgres OwnershipStore.
 *
 * Note what is NOT here: no joins across to anything Part Two owns, and no
 * query that could be reused on a resolution path. The store answers the four
 * questions the seam asks and nothing else (§4.1).
 */

import type { Queryable } from '../db.ts';
import type {
  Allocation,
  AuthorizationRecord,
  Membership,
  Organization,
  OwnershipStore,
} from './types.ts';

export class PgOwnershipStore implements OwnershipStore {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async allocationByTlp(tlp: string): Promise<Allocation | null> {
    const { rows } = await this.db.query<Allocation>(
      `SELECT id, tlp, org_id, status, class, allocated_at, expires_at,
              grandfathered, pending_claimant, closed_to_registration, notes
         FROM allocation
        WHERE tlp = $1`,
      [tlp],
    );
    return rows[0] ?? null;
  }

  async organizationById(orgId: string): Promise<Organization | null> {
    const { rows } = await this.db.query<Organization>(
      `SELECT id, name, website, contact_email, status, is_operator
         FROM organization
        WHERE id = $1`,
      [orgId],
    );
    return rows[0] ?? null;
  }

  async membershipsOfUser(userId: string): Promise<Membership[]> {
    const { rows } = await this.db.query<Membership>(
      `SELECT org_id, user_id, role FROM member WHERE user_id = $1`,
      [userId],
    );
    return rows;
  }

  async authorizationsForAllocation(allocationId: string): Promise<AuthorizationRecord[]> {
    const { rows } = await this.db.query<AuthorizationRecord>(
      `SELECT id, allocation_id, scope, grantee_org_id, status, granted_at, expires_at
         FROM authorization_record
        WHERE allocation_id = $1`,
      [allocationId],
    );
    return rows;
  }
}
