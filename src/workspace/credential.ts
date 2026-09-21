/**
 * The workspace credential — design §20.3.
 *
 * One credential per surface, and the host itself checks exactly one: this
 * one, on `PUT` and `DELETE /<name>:unpublished`. Every `GET` on either
 * surface is open, and a write to a Registry path carries the caller's own
 * canon token, which this host never reads.
 *
 * FIRST FORM — the environment, in the mold of the Phase 0 `CP_AUTHOR_*`
 * bootstrap credential (§15.2):
 *
 *   CP_WORKSPACE_TOKEN        one token, 32+ characters; label "workspace"
 *   CP_WORKSPACE_TOKENS       several, as `label=token,label=token`
 *   CP_WORKSPACE_PRINCIPAL    the person answerable for saves made with them
 *
 * It carries no scopes because there is only one act it enables, and its
 * reach is not on the token: `WORKSPACE_ORGS` fixes what the workspace will
 * hold, so a leaked token can overwrite one organization's drafts on that
 * organization's host and nothing else. That bounded blast radius is what
 * makes an environment credential acceptable here where it stopped being
 * acceptable on canon. It also means the workspace cannot tell an author
 * from an assistant: two tokens with two labels is the discipline.
 *
 * `mayWriteWorkspace` is ONE function so the second form — asking canon who
 * the bearer is and applying the seam's membership rule from the mirrored
 * allocation facts (§25 Q14) — is a drop-in, and clients keep sending
 * `Authorization: Bearer` exactly as they do now.
 */

import { timingSafeEqual } from 'node:crypto';

export type WorkspaceCredential = {
  token: string;
  label: string;
  principal: string;
};

export const MIN_TOKEN_LENGTH = 32;

/** Read the environment form. Returns [] when nothing is configured; throws on a half-configured one. */
export function workspaceCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceCredential[] {
  const one = env['CP_WORKSPACE_TOKEN']?.trim();
  const many = env['CP_WORKSPACE_TOKENS']?.trim();
  const principal = env['CP_WORKSPACE_PRINCIPAL']?.trim();

  const found: { label: string; token: string }[] = [];
  if (one) found.push({ label: 'workspace', token: one });
  if (many) {
    for (const part of many.split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) throw new Error(`CP_WORKSPACE_TOKENS: each entry is label=token; "${entry.slice(0, 12)}…" is not`);
      found.push({ label: entry.slice(0, eq).trim(), token: entry.slice(eq + 1).trim() });
    }
  }
  if (found.length === 0) return [];
  if (!principal) throw new Error('CP_WORKSPACE_PRINCIPAL names the person answerable for workspace saves; set it with the token(s).');

  const labels = new Set<string>();
  for (const { label, token } of found) {
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`workspace credential "${label}" is shorter than ${MIN_TOKEN_LENGTH} characters`);
    if (labels.has(label)) throw new Error(`workspace credential label "${label}" is used twice; labels are what updated_by records`);
    labels.add(label);
  }
  return found.map((f) => ({ ...f, principal }));
}

/**
 * The one check. Given the `Authorization` header, the credential it
 * presents — or null. Constant-time over every configured token, so timing
 * says nothing about which one was close.
 */
export function mayWriteWorkspace(credentials: readonly WorkspaceCredential[], authorization: string | undefined): WorkspaceCredential | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const presented = Buffer.from(authorization.slice(7).trim());
  let matched: WorkspaceCredential | null = null;
  for (const credential of credentials) {
    const expected = Buffer.from(credential.token);
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) matched = credential;
  }
  return matched;
}

/** What `updated_by` records: legible without a glossary. */
export function signature(credential: WorkspaceCredential): string {
  return `${credential.label} (${credential.principal})`;
}
