/**
 * Design §15.3 — identity: who a user is, and how a person gets in.
 *
 * Two tables. Neither changes what the seam reads (§9.3) or what a credential
 * is (§15.2); they only change how an `app_user` row comes to exist and how a
 * person reaches the page where they mint their own tokens.
 *
 * 1. `user_identity` — one row per (provider, subject): a Google or GitHub
 *    account that has signed in, attached to the app_user it resolved to by
 *    the linking rule (§15.3). A user may have several. The provider's
 *    subject is the durable key; the email is the linking key at first sight
 *    only, so it is recorded as the provider asserted it and never used to
 *    move an identity afterwards.
 *
 * 2. `session` — a browser's signed-in state: the SHA-256 of a random id the
 *    browser holds in a cookie, who it is, when it expires, when it was last
 *    seen, whether it was revoked. Sessions are honoured only on /auth/* and
 *    /account; no authoring or operator route ever authenticates by cookie.
 *
 * `app_user.oidc_subject` (migration 1) is retained and no longer read by the
 * sign-in code; `user_identity` is authoritative for identity from here on.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createType('identity_provider', ['google', 'github']);

  pgm.createTable('user_identity', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    app_user_id: { type: 'uuid', notNull: true, references: 'app_user', onDelete: 'CASCADE' },
    provider: { type: 'identity_provider', notNull: true },
    subject: { type: 'text', notNull: true, comment: "The provider's stable identifier for the account (Google `sub`, GitHub user id)." },
    email: { type: 'text', notNull: true, comment: 'As the provider asserted it at first sign-in. Not a key after linking.' },
    email_verified: { type: 'boolean', notNull: true },
    display_name: { type: 'text' },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('user_identity', 'user_identity_provider_subject', { unique: ['provider', 'subject'] });
  pgm.createIndex('user_identity', 'app_user_id');

  // The linking rule's second step asks "exactly one app_user with this
  // email?" — case-insensitively, since providers differ in what they return.
  pgm.createIndex('app_user', 'lower(email)', { name: 'app_user_email_lower' });

  pgm.createTable('session', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    token_hash: { type: 'text', notNull: true, unique: true, comment: 'SHA-256 of the random session id the browser holds.' },
    app_user_id: { type: 'uuid', notNull: true, references: 'app_user', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true, comment: 'Absolute expiry; the idle expiry is computed from last_seen_at.' },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.createIndex('session', 'app_user_id');
}

export async function down(pgm) {
  pgm.dropTable('session');
  pgm.dropIndex('app_user', 'lower(email)', { name: 'app_user_email_lower' });
  pgm.dropTable('user_identity');
  pgm.dropType('identity_provider');
}
