/**
 * The operator's command line — design §9.2, §15.2.
 *
 *   npm run operator -- user find --email jane@cimetrics.com
 *   npm run operator -- user add --email jane@cimetrics.com --name "Jane Doe" --by anto@padi.io
 *   npm run operator -- member add --org "Cimetrics Inc." --user jane@cimetrics.com [--role admin] --by anto@padi.io
 *   npm run operator -- credential mint --user jane@cimetrics.com --kind human \
 *       --scopes register,steward,release,publish --label "Jane, Cimetrics author" --by anto@padi.io
 *   npm run operator -- credential mint --user anto@padi.io --kind agent --principal anto@padi.io \
 *       --scopes register,steward,release --label "Claude Desktop" --by anto@padi.io
 *   npm run operator -- credential list
 *   npm run operator -- credential revoke --id <uuid> --reason "rotated" --by anto@padi.io
 *
 * Runs against DATABASE_URL directly — inside the cluster via
 * `kubectl -n cp-registry exec deploy/registry -- npm run operator -- …` —
 * so it needs no token of its own; --by names the operator principal every
 * act is recorded under (§4.3). A minted token is printed ONCE, to this
 * terminal, and exists nowhere else: hand it over out of band
 * (deploy/CREDENTIALS.md), never through chat or email.
 *
 * Users are looked up by email or id; organizations by name or id.
 *
 * Since §15.3 people create their own accounts by signing in and mint their
 * own tokens on /account, so the everyday operator act is `member add` on an
 * email the person has already used to sign in — `user find` shows what the
 * Registry knows about that email first. `user add` and `credential mint`
 * remain for bootstrap and for agents that have no person to sign in.
 */

import { parseArgs } from 'node:util';
import type pg from 'pg';
import { closePool, getPool, inTransaction } from '../db.ts';
import { record } from '../audit.ts';
import { list, mint, revoke } from '../credentials/store.ts';
import { parseScopes, SCOPES } from '../part-two/routes.ts';

const [noun, verb, ...rest] = process.argv.slice(2);

const { values } = parseArgs({
  args: rest,
  options: {
    'email': { type: 'string' },
    'name': { type: 'string' },
    'org': { type: 'string' },
    'user': { type: 'string' },
    'role': { type: 'string' },
    'kind': { type: 'string' },
    'principal': { type: 'string' },
    'scopes': { type: 'string' },
    'label': { type: 'string' },
    'id': { type: 'string' },
    'reason': { type: 'string' },
    'by': { type: 'string' },
  },
});

function usage(problem?: string): never {
  if (problem) console.error(`${problem}\n`);
  console.error(`Usage:
  npm run operator -- user find --email <email>
  npm run operator -- user add --email <email> --name "<display name>" --by <operator email>
  npm run operator -- member add --org "<org name or id>" --user <email or id> [--role author|admin] --by <operator email>
  npm run operator -- credential mint --user <email or id> --kind human|service|agent [--principal <email>]
                                        --scopes <a,b,c> --label "<what it is for>" --by <operator email>
  npm run operator -- credential list
  npm run operator -- credential revoke --id <uuid> --reason "<why>" --by <operator email>

Scopes: ${SCOPES.join(' · ')}`);
  process.exit(1);
}

const by = values.by ?? process.env['CP_AUTHOR_PRINCIPAL'];
function requireBy(): string {
  if (!by) usage('--by (or CP_AUTHOR_PRINCIPAL in the environment) is required: every operator act names the person who did it (§4.3).');
  return by;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function userId(db: pg.PoolClient, ref: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    UUID.test(ref) ? `SELECT id FROM app_user WHERE id = $1` : `SELECT id FROM app_user WHERE email = $1`,
    [ref],
  );
  if (!rows[0]) throw new Error(`no app_user "${ref}" — create one first: npm run operator -- user add --email ${ref} --name "…"`);
  return rows[0].id;
}

async function orgId(db: pg.PoolClient, ref: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    UUID.test(ref) ? `SELECT id FROM organization WHERE id = $1` : `SELECT id FROM organization WHERE name = $1`,
    [ref],
  );
  if (!rows[0]) throw new Error(`no organization "${ref}" (names are matched exactly; try the id)`);
  return rows[0].id;
}

async function main(): Promise<void> {
  if (noun === 'user' && verb === 'find') {
    if (!values.email) usage('user find needs --email.');
    const email = values.email;
    const users = await getPool().query<{ id: string; email: string; display_name: string | null; created: Date }>(
      `SELECT id, email, display_name, created FROM app_user WHERE lower(email) = lower($1) ORDER BY created`,
      [email],
    );
    if (users.rows.length === 0) {
      console.log(`no user carries ${email}. They can create one by signing in at /account; or: npm run operator -- user add --email ${email} --name "…"`);
      return;
    }
    for (const u of users.rows) {
      console.log(`user ${u.id}  ${u.email}  ${u.display_name ?? ''}  created ${u.created.toISOString().slice(0, 10)}`);
      const ids = await getPool().query<{ provider: string; email: string; last_seen: Date }>(
        `SELECT provider::text AS provider, email, last_seen FROM user_identity WHERE app_user_id = $1 ORDER BY first_seen`, [u.id]);
      for (const i of ids.rows) console.log(`  identity   ${i.provider.padEnd(7)} ${i.email}  last seen ${i.last_seen.toISOString().slice(0, 10)}`);
      if (ids.rows.length === 0) console.log(`  identity   none — has not signed in yet`);
      const ms = await getPool().query<{ name: string; role: string; prefixes: string[] | null }>(
        `SELECT o.name, m.role::text AS role,
                (SELECT array_agg(a.tlp ORDER BY a.tlp) FROM allocation a WHERE a.org_id = o.id AND a.status IN ('active','locked')) AS prefixes
           FROM member m JOIN organization o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name`, [u.id]);
      for (const m of ms.rows) console.log(`  member     ${m.role.padEnd(7)} ${m.name}  →  ${(m.prefixes ?? []).map((t) => `cp:${t}`).join(' ') || '(no Prefix held)'}`);
      if (ms.rows.length === 0) console.log(`  member     of nothing — tokens will be refused with no-membership until: npm run operator -- member add --org "…" --user ${u.email} --by <you>`);
      const cs = await getPool().query<{ id: string; label: string; kind: string; scopes: string[]; revoked_at: Date | null; last_used_at: Date | null }>(
        `SELECT id, label, kind, scopes, revoked_at, last_used_at FROM credential WHERE app_user_id = $1 ORDER BY created_at`, [u.id]);
      for (const c of cs.rows) console.log(`  credential ${c.id}  ${c.kind.padEnd(7)} ${c.scopes.join(',')}  "${c.label}"  ${c.revoked_at ? 'REVOKED' : c.last_used_at ? `last used ${c.last_used_at.toISOString().slice(0, 10)}` : 'never used'}`);
    }
    return;
  }

  if (noun === 'user' && verb === 'add') {
    if (!values.email || !values.name) usage('user add needs --email and --name.');
    const who = requireBy();
    const id = await inTransaction(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO app_user (oidc_subject, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [`local|${values.email}`, values.email, values.name],
      );
      await record(db, {
        actor: who, actor_kind: 'operator', principal: who,
        action: 'user.create', subject_type: 'app_user', subject_id: rows[0]!.id,
        after: { email: values.email, display_name: values.name },
        rationale: `Created by ${who} for credential issuance (§15.2).`,
      });
      return rows[0]!.id;
    });
    console.log(`user ${id} created for ${values.email}`);
    return;
  }

  if (noun === 'member' && verb === 'add') {
    if (!values.org || !values.user) usage('member add needs --org and --user.');
    const role = values.role ?? 'author';
    if (role !== 'author' && role !== 'admin') usage('--role is author or admin.');
    const who = requireBy();
    const result = await inTransaction(async (db) => {
      const org = await orgId(db, values.org!);
      const user = await userId(db, values.user!);
      const { rowCount } = await db.query(
        `INSERT INTO member (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT member_unique_per_org DO NOTHING`,
        [org, user, role],
      );
      if (!rowCount) return { org, user, added: false };
      await record(db, {
        actor: who, actor_kind: 'operator', principal: who, org_id: org,
        action: 'member.add', subject_type: 'member', subject_id: user,
        after: { org_id: org, user_id: user, role },
        rationale: `Membership added by ${who}: authorization to act under the organization's Prefixes (design §5).`,
      });
      return { org, user, added: true };
    });
    console.log(result.added ? `member added: user ${result.user} → org ${result.org} as ${role}` : `already a member; nothing changed`);
    return;
  }

  if (noun === 'credential' && verb === 'mint') {
    if (!values.user || !values.kind || !values.scopes || !values.label) usage('credential mint needs --user, --kind, --scopes and --label.');
    const kind = values.kind;
    if (kind !== 'human' && kind !== 'service' && kind !== 'agent') usage('--kind is human, service or agent.');
    const scopes = parseScopes(values.scopes);
    if (scopes.length === 0) usage(`--scopes named nothing known. Known: ${SCOPES.join(', ')}`);
    const who = requireBy();
    const { token, id } = await inTransaction(async (db) => {
      const user = await userId(db, values.user!);
      return mint(db, { userId: user, kind, ...(values.principal ? { principal: values.principal } : {}), scopes, label: values.label!, by: who });
    });
    console.log(`credential ${id} minted — ${kind}, scopes ${scopes.join(',')}, "${values.label}"`);
    console.log(`\nThe token, shown once and stored nowhere:\n\n  ${token}\n\nHand it over out of band. To revoke: npm run operator -- credential revoke --id ${id} --reason "…"`);
    return;
  }

  if (noun === 'credential' && verb === 'list') {
    const rows = await list(getPool());
    if (rows.length === 0) { console.log('no credentials in the table'); return; }
    for (const r of rows) {
      const state = r.revoked_at ? `REVOKED ${r.revoked_at.toISOString().slice(0, 10)} by ${r.revoked_by}` : 'active';
      const used = r.last_used_at ? r.last_used_at.toISOString().slice(0, 16).replace('T', ' ') : 'never';
      console.log(`${r.id}  ${state.padEnd(34)} ${r.kind.padEnd(7)} ${r.scopes.join(',').padEnd(44)} used ${used}  "${r.label}"${r.principal ? `  for ${r.principal}` : ''}`);
    }
    return;
  }

  if (noun === 'credential' && verb === 'revoke') {
    if (!values.id || !values.reason) usage('credential revoke needs --id and --reason.');
    const who = requireBy();
    const done = await inTransaction((db) => revoke(db, values.id!, who, values.reason!));
    console.log(done ? `credential ${values.id} revoked; it answers 401 from now on` : `credential ${values.id} was already revoked, or does not exist`);
    return;
  }

  usage();
}

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
