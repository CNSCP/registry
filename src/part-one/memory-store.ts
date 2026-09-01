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
} from './types.ts';

export type MemoryData = {
  organizations?: Organization[];
  allocations?: Allocation[];
  memberships?: Membership[];
  authorizations?: AuthorizationRecord[];
};

export class MemoryOwnershipStore implements OwnershipStore {
  readonly organizations = new Map<string, Organization>();
  readonly allocations = new Map<string, Allocation>();
  readonly memberships: Membership[] = [];
  readonly authorizations: AuthorizationRecord[] = [];

  constructor(data: MemoryData = {}) {
    for (const o of data.organizations ?? []) this.addOrganization(o);
    for (const a of data.allocations ?? []) this.addAllocation(a);
    for (const m of data.memberships ?? []) this.memberships.push(m);
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

  addMembership(membership: Membership): this {
    this.memberships.push(membership);
    return this;
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
