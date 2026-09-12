/**
 * Credentials as rows — design §15.2, 12 September 2026.
 *
 * Phase 0 read one static bearer token from the environment. A second author
 * needs a second token, a way to mint it without a redeploy, and a way to
 * revoke it. This table is that: one row per token, holding the SHA-256 of
 * the token and never the token itself — a database dump reveals nothing a
 * client could present.
 *
 * `scopes` is the §15.2 list as text; the application validates it against
 * its own Scope type at load. `kind` reuses the audit log's actor_kind minus
 * `operator` (a credential is held by a person, a service, or an agent).
 * `principal` is required unless kind = human (§4.3), enforced here as it is
 * on audit_event.
 *
 * Minting and revoking are audited acts (credential.mint, credential.revoke)
 * written in the same transaction; the journal redacts them (§20.1), since
 * they are about the operator's own housekeeping, not about names.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createTable('credential', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    token_hash: { type: 'text', notNull: true, unique: true, comment: 'SHA-256 hex of the bearer token; the token is shown once at minting and never stored' },
    app_user_id: { type: 'uuid', notNull: true, references: 'app_user', onDelete: 'RESTRICT' },
    kind: { type: 'text', notNull: true, comment: 'human | service | agent' },
    principal: { type: 'text', comment: 'The human a service or agent acts for (§4.3). Required unless kind = human.' },
    scopes: { type: 'text[]', notNull: true, comment: 'register · steward · release · publish · deprecate · operator (§15.2)' },
    label: { type: 'text', notNull: true, comment: 'What this token is for, in the operator’s words' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'text', notNull: true, comment: 'The operator principal who minted it' },
    revoked_at: { type: 'timestamptz' },
    revoked_by: { type: 'text' },
    last_used_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('credential', 'credential_kind', { check: "kind IN ('human','service','agent')" });
  pgm.addConstraint('credential', 'credential_principal_required', { check: "kind = 'human' OR principal IS NOT NULL" });
  pgm.createIndex('credential', 'app_user_id');
}

export async function down(pgm) {
  pgm.dropTable('credential');
}
