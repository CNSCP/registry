/**
 * Design §6.1, §6.2 — organizations, users, and membership.
 *
 * Authentication identity (the OIDC subject) lives on `app_user`; authorization
 * lives on `member`. Keeping them apart is what lets a person belong to more
 * than one organization without their identity being duplicated per membership.
 */

export const shorthands = undefined;

export async function up(pgm) {
  // No extensions. `gen_random_uuid()` has been core since PostgreSQL 13 and
  // `sha256()` since 11, so the schema needs neither pgcrypto nor uuid-ossp —
  // one less thing that must be installed before a local instance can run.
  pgm.createType('organization_status', ['applied', 'verified', 'active', 'suspended', 'dissolved']);
  pgm.createType('member_role', ['author', 'admin']);

  pgm.createTable('organization', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, comment: 'Legal or display name' },
    website: { type: 'text', comment: 'Used in verification (§8.1)' },
    contact_email: { type: 'text' },
    status: { type: 'organization_status', notNull: true, default: 'applied' },
    // Method, evidence, verified_at, verified_by. Shapeless on purpose: the
    // evidence for a DNS challenge and for a legal-entity attestation have
    // nothing in common, and §8.1 anticipates more methods arriving.
    verification: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    is_operator: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'The operator organization itself. Exactly one row may set this.',
    },
    created: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    modified: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Exactly one operator organization.
  pgm.createIndex('organization', 'is_operator', {
    unique: true,
    where: 'is_operator',
    name: 'organization_single_operator',
  });

  pgm.createTable('app_user', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    oidc_subject: { type: 'text', notNull: true, unique: true },
    email: { type: 'text', notNull: true },
    display_name: { type: 'text' },
    created: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('member', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'organization', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'app_user', onDelete: 'CASCADE' },
    role: { type: 'member_role', notNull: true, default: 'author' },
    created: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('member', 'member_unique_per_org', { unique: ['org_id', 'user_id'] });
  pgm.createIndex('member', 'user_id');
}

export async function down(pgm) {
  pgm.dropTable('member');
  pgm.dropTable('app_user');
  pgm.dropTable('organization');
  pgm.dropType('member_role');
  pgm.dropType('organization_status');
}
