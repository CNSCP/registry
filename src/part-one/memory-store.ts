/**
 * In-memory OwnershipStore.
 *
 * Not a mock — a second real implementation of the same interface. It is what
 * makes the §23 authorization table tests runnable without Postgres, and it is
 * also the shape the Phase 0 seed data takes before it is loaded.
 */

import type {
  Allocation,
  AuthorizationRecord,
  Membership,
  Organization,
  OwnershipStore,
  RoleGrant,
} from './types.ts';

/**
 * The roles migration 14 backfilled for a membership as it stood: `*`, with
 * register+publish for an author and admin besides for an admin. A test that
 * adds a membership without saying which roles gets exactly what a member of
 * that kind had on the day roles arrived — and says otherwise by passing them.
 */
export function backfilledRoles(m: Membership): RoleGrant {
  return {
    org_id: m.org_id,
    user_id: m.user_id,
    branch: '*',
    reach: 'branch',
    roles: m.role === 'admin' ? ['admin', 'register', 'publish'] : ['register', 'publish'],
  };
}

export type MemoryData = {
  organizations?: Organization[];
  allocations?: Allocation[];
  memberships?: Membership[];
  authorizations?: AuthorizationRecord[];
  /** Absent: each membership gets its backfilled roles. Present: exactly these. */
  roles?: RoleGrant[];
};

export class MemoryOwnershipStore implements OwnershipStore {
  readonly organizations = new Map<string, Organization>();
  readonly allocations = new Map<string, Allocation>();
  readonly memberships: Membership[] = [];
  readonly authorizations: AuthorizationRecord[] = [];
  readonly roles: RoleGrant[] = [];

  constructor(data: MemoryData = {}) {
    for (const o of data.organizations ?? []) this.addOrganization(o);
    for (const a of data.allocations ?? []) this.addAllocation(a);
    for (const m of data.memberships ?? []) this.memberships.push(m);
    for (const r of data.roles ?? (data.memberships ?? []).map(backfilledRoles)) this.roles.push(r);
    for (const g of data.authorizations ?? []) this.authorizations.push(g);
  }

  addOrganization(org: Organization): this {
    this.organizations.set(org.id, org);
    return this;
  }

  addAllocation(allocation: Allocation): this {
    this.allocations.set(allocation.tlp, allocation);
    return this;
  }

  /** With no roles given, the membership gets its backfilled roles (see `backfilledRoles`); `[]` gives none. */
  addMembership(membership: Membership, roles?: RoleGrant[]): this {
    this.memberships.push(membership);
    for (const r of roles ?? [backfilledRoles(membership)]) this.roles.push(r);
    return this;
  }

  addRole(role: RoleGrant): this {
    this.roles.push(role);
    return this;
  }

  async rolesOfUser(userId: string): Promise<RoleGrant[]> {
    return this.roles.filter((r) => r.user_id === userId);
  }

  addAuthorization(record: AuthorizationRecord): this {
    this.authorizations.push(record);
    return this;
  }

  async allocationByTlp(tlp: string): Promise<Allocation | null> {
    return this.allocations.get(tlp) ?? null;
  }

  async organizationById(orgId: string): Promise<Organization | null> {
    return this.organizations.get(orgId) ?? null;
  }

  async membershipsOfUser(userId: string): Promise<Membership[]> {
    return this.memberships.filter((m) => m.user_id === userId);
  }

  async authorizationsForAllocation(allocationId: string): Promise<AuthorizationRecord[]> {
    return this.authorizations.filter((a) => a.allocation_id === allocationId);
  }
}
