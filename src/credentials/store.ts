/**
 * Credentials — design §15.2.
 *
 * A token is a random 32-byte secret shown once, at minting, to the operator
 * who minted it. The table holds its SHA-256 and the facts a request needs:
 * which app_user it acts as, what kind of actor, for which person, with which
 * scopes. `authenticate()` in part-two/routes.ts hashes the presented token
 * and looks the hash up here; nothing in the database can be presented back.
 *
 * Every function takes a Queryable so the caller controls the transaction —
 * minting and revoking are audited in the same transaction as the row (§4.3).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db.ts';
import { record } from '../audit.ts';
import { SCOPES, type Credential, type Scope } from '../part-two/routes.ts';

export type CredentialRow = {
  id: string;
  app_user_id: string;
  kind: 'human' | 'service' | 'agent';
  principal: string | null;
  scopes: string[];
  label: string;
  created_at: Date;
  created_by: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes as hex: 64 characters, well above the 32-character floor. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** What a request needs to know about the presented token, or null. Revoked rows never match. */
export async function findByToken(db: Queryable, token: string): Promise<(Credential & { id: string; label: string }) | null> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT id, app_user_id, kind, principal, scopes, label, created_at, created_by, revoked_at, revoked_by, last_used_at
       FROM credential WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    token,
    userId: row.app_user_id,
    kind: row.kind,
    ...(row.principal ? { principal: row.principal } : {}),
    scopes: row.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
  };
}

/** Best-effort; a failed touch must never fail a request. */
export async function touch(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE credential SET last_used_at = now() WHERE id = $1`, [id]).catch(() => undefined);
}

export type MintRequest = {
  userId: string;
  kind: 'human' | 'service' | 'agent';
  principal?: string;
  scopes: Scope[];
  label: string;
  /** The principal doing the minting, for the audit event: an operator from the CLI, or the user themselves on /account (§15.3). */
  by: string;
  /** How `by` acted. Defaults to 'operator' (the CLI); /account passes 'human'. */
  byKind?: 'operator' | 'human';
};

/**
 * Mint a token. Returns the token — the only time it exists in plaintext —
 * and the row. Call on the client of an open transaction.
 */
export async function mint(db: Queryable, request: MintRequest): Promise<{ token: string; id: string }> {
  if (request.kind !== 'human' && !request.principal) {
    throw new Error(`a ${request.kind} credential needs a principal: the person it acts for (§4.3)`);
  }
  if (request.scopes.length === 0) throw new Error('a credential with no scopes can do nothing; name at least one');
  for (const s of request.scopes) {
    if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`unknown scope "${s}"; known: ${SCOPES.join(', ')}`);
  }
  if (!request.label.trim()) throw new Error('a label is required: what is this token for?');

  const token = newToken();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO credential (token_hash, app_user_id, kind, principal, scopes, label, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [hashToken(token), request.userId, request.kind, request.principal ?? null, request.scopes, request.label, request.by],
  );
  const id = rows[0]!.id;

  await record(db, {
    actor: request.by,
    actor_kind: request.byKind ?? 'operator',
    principal: request.by,
    action: 'credential.mint',
    subject_type: 'credential',
    subject_id: id,
    after: { user_id: request.userId, kind: request.kind, principal: request.principal ?? null, scopes: request.scopes, label: request.label },
    rationale: `Minted by ${request.by}: ${request.label}`,
  });

  return { token, id };
}

/** Revoke a token. Idempotent; an already-revoked row is left as it was. */
export async function revoke(db: Queryable, id: string, by: string, reason: string, byKind: 'operator' | 'human' = 'operator'): Promise<boolean> {
  const { rows } = await db.query<{ label: string }>(
    `UPDATE credential SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING label`,
    [id, by],
  );
  if (!rows[0]) return false;
  await record(db, {
    actor: by,
    actor_kind: byKind,
    principal: by,
    action: 'credential.revoke',
    subject_type: 'credential',
    subject_id: id,
    before: { revoked: false },
    after: { revoked: true, label: rows[0].label },
    rationale: reason,
  });
  return true;
}

export async function list(db: Queryable): Promise<CredentialRow[]> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT c.id, c.app_user_id, c.kind, c.principal, c.scopes, c.label, c.created_at, c.created_by,
            c.revoked_at, c.revoked_by, c.last_used_at
       FROM credential c ORDER BY c.created_at`,
  );
  return rows;
}
