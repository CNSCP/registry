/**
 * Identity — design §15.3.
 *
 * Two things live here, and they are deliberately not the same thing:
 *
 * - The LINKING RULE: when a provider has just told us "this is Google account
 *   X with verified email E", which app_user is that? Applied in one
 *   transaction at every sign-in, in a fixed order (§15.3): the provider's
 *   subject wins if known; otherwise a verified email matching exactly one
 *   existing user attaches to that user; otherwise a user is created. An
 *   unverified email never links and never creates.
 *
 * - SESSIONS: a browser's signed-in state. A session is honoured on /auth/*
 *   and /account only. It is not a credential (§15.2): no act on the Registry
 *   is ever authenticated by a session, so the cookie cannot be turned into a
 *   registration or a publication by a cross-site request.
 *
 * Every function takes a Queryable so the caller controls the transaction;
 * the linking rule writes to the audit chain and must run inside one.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db.ts';
import { record } from '../audit.ts';

export const PROVIDERS = ['google', 'github'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** What a provider asserts about the person who just signed in. */
export type AssertedIdentity = {
  provider: ProviderName;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
};

export type LinkOutcome = 'known' | 'linked' | 'created';
export type LinkResult = { userId: string; identityId: string; outcome: LinkOutcome };

export type IdentityRefusalCode = 'email-unverified' | 'email-ambiguous';

/** A sign-in the linking rule declines. Nothing was written. */
export class IdentityRefused extends Error {
  code: IdentityRefusalCode;
  constructor(code: IdentityRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The linking rule (§15.3). Call inside a transaction; the audit event and
 * the rows commit or roll back together.
 */
export async function linkOrCreate(db: Queryable, asserted: AssertedIdentity): Promise<LinkResult> {
  const email = asserted.email.trim();
  const displayName = asserted.displayName?.trim() || null;

  // 1. The provider's subject is the durable key. Known → done; nothing else
  //    is consulted, so a later email change at the provider moves nothing.
  const known = await db.query<{ id: string; app_user_id: string }>(
    `UPDATE user_identity
        SET last_seen = now(), display_name = COALESCE($3, display_name)
      WHERE provider = $1 AND subject = $2
      RETURNING id, app_user_id`,
    [asserted.provider, asserted.subject, displayName],
  );
  if (known.rows[0]) return { userId: known.rows[0].app_user_id, identityId: known.rows[0].id, outcome: 'known' };

  // An unverified email never links and never creates: anyone could assert one.
  if (!asserted.emailVerified || !email) {
    throw new IdentityRefused(
      'email-unverified',
      `${asserted.provider} did not assert a verified email for this account; the Registry links and creates accounts by verified email only (§15.3).`,
    );
  }

  // 2. A verified email matching exactly one existing user attaches to it —
  //    the row the operator created in advance, or the user's other provider.
  const byEmail = await db.query<{ id: string }>(`SELECT id FROM app_user WHERE lower(email) = lower($1)`, [email]);
  if (byEmail.rows.length > 1) {
    throw new IdentityRefused(
      'email-ambiguous',
      `More than one Registry user carries ${email}; an operator has to resolve this before the account can be linked.`,
    );
  }
  if (byEmail.rows.length === 1) {
    const userId = byEmail.rows[0]!.id;
    const identityId = await insertIdentity(db, userId, asserted, email, displayName);
    await record(db, {
      actor: email,
      actor_kind: 'human',
      action: 'user.identity_link',
      subject_type: 'app_user',
      subject_id: userId,
      after: { provider: asserted.provider, subject: asserted.subject, email },
      rationale: `Signed in with ${asserted.provider}; verified email matched this user (§15.3 rule 2).`,
    });
    return { userId, identityId, outcome: 'linked' };
  }

  // 3. Nobody carries this email: a new user, made by the person themselves.
  const created = await db.query<{ id: string }>(
    `INSERT INTO app_user (oidc_subject, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [`${asserted.provider}|${asserted.subject}`, email, displayName],
  );
  const userId = created.rows[0]!.id;
  const identityId = await insertIdentity(db, userId, asserted, email, displayName);
  await record(db, {
    actor: email,
    actor_kind: 'human',
    action: 'user.create',
    subject_type: 'app_user',
    subject_id: userId,
    after: { email, display_name: displayName, identity: { provider: asserted.provider, subject: asserted.subject } },
    rationale: `Self-registered by signing in with ${asserted.provider} (§15.3 rule 3).`,
  });
  return { userId, identityId, outcome: 'created' };
}

async function insertIdentity(
  db: Queryable,
  userId: string,
  asserted: AssertedIdentity,
  email: string,
  displayName: string | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO user_identity (app_user_id, provider, subject, email, email_verified, display_name)
     VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
    [userId, asserted.provider, asserted.subject, email, displayName],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The cookie value is `id.signature`: a forged or tampered cookie fails the
 * HMAC before the database is consulted. The database holds only hash(id).
 */
export function signSessionId(id: string, secret: string): string {
  return `${id}.${createHmac('sha256', secret).update(id).digest('hex')}`;
}

export function verifySessionCookie(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(id).digest('hex');
  if (sig.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8')) ? id : null;
}

export type Session = { rowId: string; userId: string; expiresAt: Date };

export async function createSession(db: Queryable, userId: string, now = new Date()): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await db.query(
    `INSERT INTO session (token_hash, app_user_id, created_at, expires_at, last_seen_at) VALUES ($1, $2, $3, $4, $3)`,
    [hash(id), userId, now, expiresAt],
  );
  return { id, expiresAt };
}

/** The live session for an id, or null: revoked, past its absolute expiry, or idle too long. */
export async function findSession(db: Queryable, id: string, now = new Date()): Promise<Session | null> {
  const { rows } = await db.query<{ id: string; app_user_id: string; expires_at: Date; last_seen_at: Date; revoked_at: Date | null }>(
    `SELECT id, app_user_id, expires_at, last_seen_at, revoked_at FROM session WHERE token_hash = $1`,
    [hash(id)],
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  if (row.expires_at.getTime() <= now.getTime()) return null;
  if (row.last_seen_at.getTime() + SESSION_IDLE_MS <= now.getTime()) return null;
  return { rowId: row.id, userId: row.app_user_id, expiresAt: row.expires_at };
}

/** Best-effort; a failed touch must never fail a request. */
export async function touchSession(db: Queryable, rowId: string, now = new Date()): Promise<void> {
  await db.query(`UPDATE session SET last_seen_at = $2 WHERE id = $1`, [rowId, now]).catch(() => undefined);
}

export async function revokeSession(db: Queryable, rowId: string): Promise<void> {
  await db.query(`UPDATE session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [rowId]);
}

// ---------------------------------------------------------------------------
// What /account shows
// ---------------------------------------------------------------------------

export type AccountView = {
  user: { id: string; email: string; displayName: string | null };
  identities: { provider: ProviderName; email: string; displayName: string | null; firstSeen: Date; lastSeen: Date }[];
  memberships: { orgId: string; orgName: string; role: string; prefixes: string[] }[];
  credentials: {
    id: string;
    label: string;
    kind: string;
    principal: string | null;
    scopes: string[];
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }[];
};

export async function accountView(db: Queryable, userId: string): Promise<AccountView | null> {
  const user = await db.query<{ id: string; email: string; display_name: string | null }>(
    `SELECT id, email, display_name FROM app_user WHERE id = $1`,
    [userId],
  );
  if (!user.rows[0]) return null;

  const identities = await db.query<{ provider: ProviderName; email: string; display_name: string | null; first_seen: Date; last_seen: Date }>(
    `SELECT provider, email, display_name, first_seen, last_seen FROM user_identity WHERE app_user_id = $1 ORDER BY first_seen`,
    [userId],
  );
  const memberships = await db.query<{ org_id: string; org_name: string; role: string; prefixes: string[] | null }>(
    `SELECT m.org_id, o.name AS org_name, m.role::text AS role,
            (SELECT array_agg(a.tlp ORDER BY a.tlp) FROM allocation a WHERE a.org_id = m.org_id AND a.status IN ('active','locked')) AS prefixes
       FROM member m JOIN organization o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY o.name`,
    [userId],
  );
  const credentials = await db.query<{
    id: string; label: string; kind: string; principal: string | null; scopes: string[];
    created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
  }>(
    `SELECT id, label, kind, principal, scopes, created_at, last_used_at, revoked_at
       FROM credential WHERE app_user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  return {
    user: { id: user.rows[0].id, email: user.rows[0].email, displayName: user.rows[0].display_name },
    identities: identities.rows.map((r) => ({ provider: r.provider, email: r.email, displayName: r.display_name, firstSeen: r.first_seen, lastSeen: r.last_seen })),
    memberships: memberships.rows.map((r) => ({ orgId: r.org_id, orgName: r.org_name, role: r.role, prefixes: r.prefixes ?? [] })),
    credentials: credentials.rows.map((r) => ({
      id: r.id, label: r.label, kind: r.kind, principal: r.principal, scopes: r.scopes,
      createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
    })),
  };
}
