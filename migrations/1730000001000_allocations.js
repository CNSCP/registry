/**
 * Design §6.3, §7.2 — allocations.
 *
 * One row per Top Level Prefix. A Prefix is allocated to exactly one party at a
 * time (spec §7.1), which the unique constraint on `tlp` enforces literally.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createType('allocation_status', [
    'requested',
    'reserved',
    'active',
    'locked',
    'redemption',
    'released',
  ]);
  pgm.createType('allocation_class', ['standard', 'restricted', 'operator', 'reserved']);

  pgm.createTable('allocation', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tlp: {
      type: 'text',
      notNull: true,
      unique: true,
      comment: 'The Prefix string, e.g. `acme`; cited as `cp:acme`',
    },
    org_id: { type: 'uuid', notNull: true, references: 'organization', comment: 'Current holder' },
    status: { type: 'allocation_status', notNull: true, default: 'requested' },
    class: { type: 'allocation_class', notNull: true, default: 'standard' },
    allocated_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz', comment: 'Renewable term (§8.2)' },
    grandfathered: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'Allocated before the specification took effect (spec §7.1)',
    },
    // §10.2 ruling 4: the seven Prefixes with real external claimants are held
    // by the operator and released to the evident owner on verification. This
    // records, publicly, who that is — so the allocation page can say the
    // Prefix is spoken for without asserting an ownership nobody has verified.
    pending_claimant: {
      type: 'text',
      comment: 'Evident owner named at import, awaiting verification under §8.1. §10.2 ruling 4.',
    },
    // §10.2 ruling 2: `proto` accepts no new registrations. Distinct from
    // `locked`, which is a dispute state and also blocks transfer.
    closed_to_registration: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'No new names may be registered beneath this Prefix. §10.2 ruling 2.',
    },
    notes: { type: 'text', comment: 'Operator rationale, published on the allocation page (§19.3)' },
    created: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    modified: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('allocation', 'org_id');
  pgm.createIndex('allocation', 'status');

  // The grammar is enforced in the application (src/names.ts) so refusals carry
  // a useful message, but the database refuses a malformed Prefix outright.
  // A one-segment Prefix has no dot, and spec §7.2 means a dotted string here
  // would be a category error rather than a bad value.
  pgm.addConstraint('allocation', 'allocation_tlp_grammar', {
    check: "tlp ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$' AND length(tlp) <= 63",
  });
}

export async function down(pgm) {
  pgm.dropTable('allocation');
  pgm.dropType('allocation_class');
  pgm.dropType('allocation_status');
}
