/** Row shapes for the §6 ownership tables, as the seam needs to see them. */

export type OrganizationStatus = 'applied' | 'verified' | 'active' | 'suspended' | 'dissolved';
export type MemberRole = 'author' | 'admin';
export type AllocationStatus =
  | 'requested'
  | 'reserved'
  | 'active'
  | 'locked'
  | 'redemption'
  | 'released';
export type AllocationClass = 'standard' | 'restricted' | 'operator' | 'reserved';
export type AuthorizationStatus = 'offered' | 'active' | 'revoked' | 'expired';
export type ActorKind = 'human' | 'service' | 'agent' | 'operator';

export type Organization = {
  id: string;
  name: string;
  website: string | null;
  contact_email: string | null;
  status: OrganizationStatus;
  is_operator: boolean;
};

export type Membership = {
  org_id: string;
  user_id: string;
  role: MemberRole;
};

export type Allocation = {
  id: string;
  tlp: string;
  org_id: string;
  status: AllocationStatus;
  class: AllocationClass;
  allocated_at: Date | null;
  expires_at: Date | null;
  grandfathered: boolean;
  pending_claimant: string | null;
  closed_to_registration: boolean;
  notes: string | null;
};

export type AuthorizationRecord = {
  id: string;
  allocation_id: string;
  scope: string;
  grantee_org_id: string;
  status: AuthorizationStatus;
  granted_at: Date;
  expires_at: Date | null;
};

/**
 * Everything `authorizes()` is allowed to read.
 *
 * Deliberately narrow. The seam (§4.1) is one query, and keeping the store
 * interface this small is what stops Part Two from quietly growing a second
 * dependency on Part One's internals. Two implementations satisfy it: Postgres
 * in production, and an in-memory map in the tests — which is why the whole
 * ownership chain is testable without a database.
 */
export interface OwnershipStore {
  allocationByTlp(tlp: string): Promise<Allocation | null>;
  organizationById(orgId: string): Promise<Organization | null>;
  membershipsOfUser(userId: string): Promise<Membership[]>;
  authorizationsForAllocation(allocationId: string): Promise<AuthorizationRecord[]>;
}

/** Who is asking. `userId` is the app_user id, never the OIDC subject. */
export type Actor = {
  userId: string;
  kind: ActorKind;
  /** The human on whose behalf a service or agent acts (§4.3, §15.1). */
  principal?: string;
};
