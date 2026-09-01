/**
 * §23 testing priority 4 — the authorization table, INCLUDING THE NEGATIVES.
 *
 * The positives here are easy and the negatives are the whole value: publishing
 * without authorization, registering a one-segment name, registering under a
 * reserved Prefix. Each has its own named reason, so a regression that starts
 * allowing one of them fails a test that says exactly what broke.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { authorizes } from '../src/part-one/authorizes.ts';
import { MemoryOwnershipStore } from '../src/part-one/memory-store.ts';
import type { Actor, Allocation, Organization } from '../src/part-one/types.ts';

// --- Fixtures ---------------------------------------------------------------

const ORG = {
  ashrae: 'org-ashrae',
  committee: 'org-committee',
  outsider: 'org-outsider',
  suspended: 'org-suspended',
  operator: 'org-operator',
} as const;

const USER = {
  ashraeAdmin: 'user-ashrae-admin',
  committeeAuthor: 'user-committee-author',
  outsider: 'user-outsider',
  suspendedMember: 'user-suspended-member',
  operatorStaff: 'user-operator-staff',
  unaffiliated: 'user-unaffiliated',
} as const;

function org(id: string, name: string, status: Organization['status'] = 'active'): Organization {
  return { id, name, website: null, contact_email: null, status, is_operator: id === ORG.operator };
}

function allocation(tlp: string, orgId: string, overrides: Partial<Allocation> = {}): Allocation {
  return {
    id: `alloc-${tlp}`,
    tlp,
    org_id: orgId,
    status: 'active',
    class: 'standard',
    allocated_at: new Date('2026-01-01'),
    expires_at: null,
    grandfathered: false,
    pending_claimant: null,
    closed_to_registration: false,
    notes: null,
    ...overrides,
  };
}

const human = (userId: string): Actor => ({ userId, kind: 'human' });

let store: MemoryOwnershipStore;

beforeEach(() => {
  store = new MemoryOwnershipStore({
    organizations: [
      org(ORG.ashrae, 'ASHRAE'),
      org(ORG.committee, 'SSPC 135 Committee'),
      org(ORG.outsider, 'Unrelated Co'),
      org(ORG.suspended, 'Suspended Co', 'suspended'),
      org(ORG.operator, 'Padi, Inc.'),
    ],
    allocations: [
      allocation('ashrae', ORG.ashrae),
      allocation('locked-co', ORG.outsider, { status: 'locked' }),
      allocation('lapsed-co', ORG.outsider, { status: 'redemption' }),
      allocation('suspended-co', ORG.suspended),
      // §10.2 ruling 2 — withheld, operator-held, closed to new registration.
      allocation('proto', ORG.operator, {
        class: 'reserved',
        grandfathered: true,
        closed_to_registration: true,
      }),
      // §10.2 ruling 4 — operator-held pending verification.
      allocation('onuma', ORG.operator, { grandfathered: true, pending_claimant: 'ONUMA' }),
      // §10.2 ruling 3 — withheld documentary.
      allocation('acme', ORG.operator, { class: 'reserved', closed_to_registration: true }),
    ],
    memberships: [
      { org_id: ORG.ashrae, user_id: USER.ashraeAdmin, role: 'admin' },
      { org_id: ORG.committee, user_id: USER.committeeAuthor, role: 'author' },
      { org_id: ORG.outsider, user_id: USER.outsider, role: 'admin' },
      { org_id: ORG.suspended, user_id: USER.suspendedMember, role: 'admin' },
      { org_id: ORG.operator, user_id: USER.operatorStaff, role: 'admin' },
    ],
    authorizations: [
      {
        id: 'grant-135',
        allocation_id: 'alloc-ashrae',
        scope: 'ashrae.135',
        grantee_org_id: ORG.committee,
        status: 'active',
        granted_at: new Date('2026-02-01'),
        expires_at: null,
      },
    ],
  });
});

// --- Positives --------------------------------------------------------------

describe('the ownership chain — allowed', () => {
  test('membership in the holding organization is authorization enough (§5)', async () => {
    const d = await authorizes(store, human(USER.ashraeAdmin), 'ashrae.223');
    assert.equal(d.allowed, true);
    assert.equal(d.allowed && d.reason, 'holder-member');
    assert.equal(d.allocation_id, 'alloc-ashrae');
  });

  test('an owner with simple needs creates no authorization records at all', async () => {
    // Any depth, any shape, no scope rows involved.
    for (const name of ['ashrae.a', 'ashrae.a.b', 'ashrae.a.b.c.d']) {
      const d = await authorizes(store, human(USER.ashraeAdmin), name);
      assert.equal(d.allowed, true, name);
    }
  });

  test('a scope grant authorizes the grantee within it', async () => {
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet');
    assert.equal(d.allowed, true);
    assert.equal(d.allowed && d.reason, 'authorization-scope');
    assert.equal(d.allowed && d.authorization_id, 'grant-135');
  });

  test('a scope covers its own exact name', async () => {
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135');
    assert.equal(d.allowed, true);
  });

  test('no interior name need exist for a scope to work (spec §7.1)', async () => {
    // Nothing named ashrae.135 is registered anywhere in this fixture.
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.wg.draft-a');
    assert.equal(d.allowed, true);
  });

  test('operator staff may act beneath a withheld Prefix that is open', async () => {
    // Withheld means operator-HELD (§3.2). Refusing on the withheld list would
    // deny the operator its own Prefixes.
    const d = await authorizes(store, human(USER.operatorStaff), 'onuma.studio');
    assert.equal(d.allowed, true);
    assert.equal(d.allowed && d.reason, 'holder-member');
  });
});

// --- The negatives ----------------------------------------------------------

describe('the negatives — §23 priority 4', () => {
  test('registering a one-segment name is refused as a category error (spec §7.2)', async () => {
    const d = await authorizes(store, human(USER.ashraeAdmin), 'ashrae');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'name-single-segment');
    assert.match(d.detail, /denotes an allocation/);
  });

  test('the bare `proto` record cannot be registered even by the operator', async () => {
    // §10.2 ruling 2 in force: the record exists on cp.padi.io today and the
    // importer must not carry it across.
    const d = await authorizes(store, human(USER.operatorStaff), 'proto');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'name-single-segment');
  });

  test('registering under a spec-reserved Prefix is refused (spec §7.1)', async () => {
    for (const name of ['test.abc', 'example.thermostat']) {
      const d = await authorizes(store, human(USER.operatorStaff), name);
      assert.equal(d.allowed, false, name);
      assert.equal(d.reason, 'prefix-spec-reserved', name);
    }
  });

  test('`test` is refused even for the operator, who authored test.abc', async () => {
    // The ruling that made test.abc move to padi.test.abc. If this test ever
    // passes as allowed, the v0.5 bootstrap has been quietly undone.
    const d = await authorizes(store, human(USER.operatorStaff), 'test.abc');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'prefix-spec-reserved');
  });

  test('the replacement name padi.test.abc is fine — `test` as a segment is not `test` as a Prefix', async () => {
    store.addAllocation(allocation('padi', ORG.operator, { grandfathered: true }));
    const d = await authorizes(store, human(USER.operatorStaff), 'padi.test.abc');
    assert.equal(d.allowed, true);
  });

  test('publishing without authorization is refused', async () => {
    const d = await authorizes(store, human(USER.outsider), 'ashrae.135.bacnet', { intent: 'publish' });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'no-covering-scope');
  });

  test('publishing without authorization is refused for the same reason as registering', async () => {
    // The ownership chain applies to both acts (spec §7.3). It is only the
    // allocation's own state that the two intents treat differently.
    const reg = await authorizes(store, human(USER.outsider), 'ashrae.x', { intent: 'register' });
    const pub = await authorizes(store, human(USER.outsider), 'ashrae.x', { intent: 'publish' });
    assert.equal(reg.allowed, false);
    assert.equal(pub.allowed, false);
    assert.equal(reg.reason, pub.reason);
  });

  test('an unaffiliated actor with no memberships at all is refused', async () => {
    const d = await authorizes(store, human(USER.unaffiliated), 'ashrae.anything');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'no-covering-scope');
  });

  test('an unallocated Prefix is refused', async () => {
    const d = await authorizes(store, human(USER.ashraeAdmin), 'nobody.owns-this');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'allocation-not-found');
  });

  test('a scope does not reach outside itself', async () => {
    // The committee holds ashrae.135 and nothing else.
    for (const name of ['ashrae.223', 'ashrae.1350', 'ashrae']) {
      const d = await authorizes(store, human(USER.committeeAuthor), name);
      assert.equal(d.allowed, false, name);
    }
  });

  test('ashrae.1350 is outside scope ashrae.135 — the segment-boundary bug', async () => {
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.1350');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'no-covering-scope');
  });

  test('an offered scope authorizes nothing until accepted', async () => {
    store.authorizations[0]!.status = 'offered';
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'scope-not-active');
    assert.match(d.detail, /must be accepted/);
  });

  test('a revoked scope authorizes nothing — revocation is immediate for future acts (§8.3)', async () => {
    store.authorizations[0]!.status = 'revoked';
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'scope-not-active');
  });

  test('an expired scope is refused, and expiry is evaluated against the given clock', async () => {
    store.authorizations[0]!.expires_at = new Date('2026-06-01');

    const before = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.x', {
      now: new Date('2026-05-01'),
    });
    assert.equal(before.allowed, true);

    const after = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.x', {
      now: new Date('2026-07-01'),
    });
    assert.equal(after.allowed, false);
    assert.equal(after.reason, 'scope-expired');
  });

  test('a locked allocation admits no new registration, but the lock is a Part One fact', async () => {
    const d = await authorizes(store, human(USER.outsider), 'locked-co.thing');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'allocation-not-active');
  });

  test('a lapsed allocation in redemption admits nothing new', async () => {
    const d = await authorizes(store, human(USER.outsider), 'lapsed-co.thing');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'allocation-not-active');
  });

  test('a suspended organization has its management writes frozen (§7.1)', async () => {
    const d = await authorizes(store, human(USER.suspendedMember), 'suspended-co.thing');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'holder-org-not-active');
  });

  test('a suspended HOLDER freezes its grantees too, not only its own members', async () => {
    // The hole the first cut of this file left open: the holder-status check
    // sat inside the membership branch, so a scope grantee kept writing beneath
    // a Prefix whose management writes were frozen. Suspension does not change
    // allocation status, so nothing else would have caught it.
    store.organizations.get(ORG.ashrae)!.status = 'suspended';
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'holder-org-not-active');
  });

  test('a suspended GRANTEE organization cannot use its scope', async () => {
    store.organizations.get(ORG.committee)!.status = 'suspended';
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'grantee-org-not-active');
  });

  test('a closed Prefix refuses new names while its existing ones are untouched', async () => {
    // §10.2 ruling 2. Even the operator cannot add to `proto`.
    const d = await authorizes(store, human(USER.operatorStaff), 'proto.something.new');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'allocation-closed-to-registration');
    assert.match(d.detail, /continue to resolve/);
  });

  test('the withheld documentary Prefixes are closed too', async () => {
    const d = await authorizes(store, human(USER.operatorStaff), 'acme.newthing');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'allocation-closed-to-registration');
  });

  test('malformed names are refused before any store lookup', async () => {
    // Counted, not assumed. A store consulted first would pass a test that only
    // checked the reason.
    let lookups = 0;
    const counting = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'allocationByTlp' || prop === 'membershipsOfUser' || prop === 'organizationById') {
          return async (...args: unknown[]) => {
            lookups++;
            return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    for (const name of ['Ashrae.Meter', 'ashrae..x', 'ashrae.-x', 'ashrae.x_y']) {
      const d = await authorizes(counting, human(USER.ashraeAdmin), name);
      assert.equal(d.allowed, false, name);
      assert.equal(d.reason, 'name-malformed', name);
    }
    assert.equal(lookups, 0, 'a malformed name reached the store');
  });
});

describe('§14 — allocation state gates REGISTRATION, not publication', () => {
  // §14 lists allocation state under Registration and lists only content gates
  // under Publication; §7.2 and §14 both say a steward hold "suspends new
  // registration" and "cannot alter, unpublish, or refuse to serve anything
  // already published". Refusing publication on this ground would be refusing
  // on a ground the specification does not state — which spec §9.3 forbids.

  test('a closed Prefix refuses new names but permits publication on existing ones', async () => {
    const register = await authorizes(store, human(USER.operatorStaff), 'proto.weather.sensor', {
      intent: 'register',
    });
    assert.equal(register.allowed, false);
    assert.equal(register.reason, 'allocation-closed-to-registration');

    const publish = await authorizes(store, human(USER.operatorStaff), 'proto.weather.sensor', {
      intent: 'publish',
    });
    assert.equal(publish.allowed, true, 'existing proto.* names must remain publishable');
  });

  test('a locked allocation blocks registration but not publication', async () => {
    const register = await authorizes(store, human(USER.outsider), 'locked-co.thing', {
      intent: 'register',
    });
    assert.equal(register.allowed, false);
    assert.equal(register.reason, 'allocation-not-active');

    const publish = await authorizes(store, human(USER.outsider), 'locked-co.thing', {
      intent: 'publish',
    });
    assert.equal(publish.allowed, true);
  });

  test('the ownership chain still applies to publication in full', async () => {
    // Waiving the allocation-state gate must not waive authorization itself.
    const d = await authorizes(store, human(USER.outsider), 'proto.weather.sensor', {
      intent: 'publish',
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'no-covering-scope');
  });

  test('a spec-reserved Prefix is refused for publication too', async () => {
    const d = await authorizes(store, human(USER.operatorStaff), 'test.abc', { intent: 'publish' });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'prefix-spec-reserved');
  });

  test('register is the default intent', async () => {
    const explicit = await authorizes(store, human(USER.operatorStaff), 'proto.new', {
      intent: 'register',
    });
    const implied = await authorizes(store, human(USER.operatorStaff), 'proto.new');
    assert.equal(implied.reason, explicit.reason);
  });
});

describe('an actor in several organizations', () => {
  test('membership in the holder wins over a scope, and neither shadows the other', async () => {
    store.addMembership({ org_id: ORG.ashrae, user_id: USER.committeeAuthor, role: 'author' });
    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.223');
    assert.equal(d.allowed, true);
    assert.equal(d.allowed && d.reason, 'holder-member');
  });

  test('an expired broad scope does not mask a usable narrower one', async () => {
    // Both cover ashrae.135.bacnet.x. The longer is dead; the answer must be
    // yes, via the live one — not a denial naming the expired record.
    store.authorizations[0]!.expires_at = new Date('2026-01-01');
    store.addAuthorization({
      id: 'grant-135-bacnet',
      allocation_id: 'alloc-ashrae',
      scope: 'ashrae.135.bacnet',
      grantee_org_id: ORG.committee,
      status: 'active',
      granted_at: new Date('2026-03-01'),
      expires_at: null,
    });

    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet.x', {
      now: new Date('2026-08-01'),
    });
    assert.equal(d.allowed, true);
    assert.equal(d.allowed && d.authorization_id, 'grant-135-bacnet');
  });

  test('when nothing is usable, the denial names the most specific covering scope', async () => {
    store.addAuthorization({
      id: 'grant-135-bacnet',
      allocation_id: 'alloc-ashrae',
      scope: 'ashrae.135.bacnet',
      grantee_org_id: ORG.committee,
      status: 'revoked',
      granted_at: new Date('2026-03-01'),
      expires_at: null,
    });
    store.authorizations[0]!.status = 'revoked';

    const d = await authorizes(store, human(USER.committeeAuthor), 'ashrae.135.bacnet.x');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'scope-not-active');
    assert.match(d.detail, /ashrae\.135\.bacnet/);
  });
});

describe('discipline: a broken link denies', () => {
  test('every deny carries a named reason and a detail that says why', async () => {
    const cases = [
      'ashrae',
      'test.abc',
      'nobody.owns-this',
      'locked-co.thing',
      'proto.new',
      'Ashrae.X',
    ];
    for (const name of cases) {
      const d = await authorizes(store, human(USER.operatorStaff), name);
      assert.equal(d.allowed, false, name);
      assert.ok(d.reason.length > 0, name);
      assert.ok(d.detail.length > 10, `${name} has an unhelpful detail: "${d.detail}"`);
    }
  });

  test('the decision shape never reports allowed without an allocation_id', async () => {
    const d = await authorizes(store, human(USER.ashraeAdmin), 'ashrae.x');
    assert.equal(d.allowed, true);
    assert.ok(d.allocation_id);
    assert.ok(d.tlp);
  });
});
