/**
 * Authoring — design §15, the authoritative profile of the `cp.` contract.
 *
 * Authoring shares the resolution paths and separates by METHOD, not prefix:
 * `cp:acme.meter.flow:draft` is `/acme.meter.flow:draft` whoever is asking and
 * whatever they intend. GET is the resolution profile every instance serves;
 * every other verb exists only here (§4.4).
 *
 * Machine and agent authoring is the primary surface (§15.1): hand-authoring
 * by an assistant is the Phase 0 publication path. Hence:
 *
 *   - structured, actionable rejections — { code, gate, ... } an agent can act
 *     on; the human-readable message is a field, never the payload
 *   - dry_run on publish, running every gate and changing nothing
 *   - idempotent writes; registration is naturally idempotent on the name
 *
 * CREDENTIAL SCOPES (§15.2). One scope per kind of act, named for the act, so
 * a token is legible without a glossary: `register` (claim a name; also
 * rehearse a publication), `steward` (Owner/Website), `release` (a
 * never-published name), `publish`, `deprecate`, and `operator` for the §9.2
 * plane. An agent normally holds register · steward · release — everything
 * preparatory and nothing permanent — and a person adds publish and
 * deprecate. (Until 12 Sept 2026 the first three were one scope, `draft:write`,
 * a name from before the Registry stopped holding drafts; the split was the
 * outside review's suggestion and Anto's ruling.) §23 priority 7 is the test
 * that containment holds under every endpoint.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';

import { record } from '../audit.ts';
import { nameProblem } from '../names.ts';
import { allocateTlp, checkAllocatable } from '../part-one/allocate.ts';
import { authorizes } from '../part-one/authorizes.ts';
import type { OwnershipStore } from '../part-one/types.ts';
import { checkAdditivityAgainstAll } from '../profile/additivity.ts';
import { missingHeaderFields, duplicatePropertyNames } from '../profile/conformance.ts';
import type { Profile, ProfileVersion } from '../profile/model.ts';
import { parseProfileVersion } from '../profile/spec2026.ts';
import { publishVersion, registerName, deprecateVersion, updateStewardship } from '../profile/store.ts';
import { splitReference } from '../part-three/routes.ts';

// 'disclose' existed while the Registry held unpublished content; the 8 Sept
// revision moved that content (and its disclosure) out of the Registry
// entirely (spec §7.3), so the scope went with it. 'draft:write' was split
// into register · steward · release on 12 Sept 2026 (see SCOPES below).
// 'operator' guards the §9.2 operator plane. No authoring credential should
// carry it by default.
export type Scope = 'register' | 'steward' | 'release' | 'publish' | 'deprecate' | 'operator';
export const SCOPES: readonly Scope[] = ['register', 'steward', 'release', 'publish', 'deprecate', 'operator'];

/**
 * Parse a comma-separated scope list as it arrives from an environment
 * variable or a CLI flag. Unknown strings are dropped, not fatal — a leftover
 * 'disclose' must not stop a server — except that the retired bundle
 * 'draft:write' is EXPANDED to the three scopes it used to mean, so a
 * credential configured before the split keeps working unchanged.
 */
export function parseScopes(text: string): Scope[] {
  const out = new Set<Scope>();
  for (const raw of text.split(',')) {
    const s = raw.trim();
    if (s === 'draft:write') { out.add('register'); out.add('steward'); out.add('release'); continue; }
    if ((SCOPES as readonly string[]).includes(s)) out.add(s as Scope);
  }
  return [...out];
}

export type Credential = {
  /** The bearer token value. */
  token: string;
  /** app_user id this credential acts as — the seam resolves the rest. */
  userId: string;
  kind: 'human' | 'service' | 'agent';
  /** Required for service/agent: the human behind it (§4.3, §15.1). */
  principal?: string;
  scopes: Scope[];
  /** Set for credentials that live in the `credential` table (§15.2). */
  id?: string;
  label?: string;
};

/** How the routes look a presented token up when it is not in the static list. */
export type CredentialLookup = {
  findByToken(token: string): Promise<Credential | null>;
  /** Best-effort last-used mark; must never throw into a request. */
  touch(id: string): Promise<void>;
};

export type AuthoringDeps = {
  pool: pg.Pool;
  ownership: OwnershipStore;
  /**
   * Static credentials from the environment — the Phase 0 bootstrap form,
   * kept so a fresh deployment can mint its first row. Empty once the table
   * carries the real ones.
   */
  credentials: Credential[];
  /** The `credential` table (migration 10). Optional so tests can run without it. */
  credentialStore?: CredentialLookup;
};

type Authed = { credential: Credential };

function structuredError(
  reply: FastifyReply,
  status: number,
  code: string,
  gate: string,
  message: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  // §15: errors distinguish Registry refusals (spec-grounded) from owner-policy
  // refusals, because the remedies differ. Everything in this file is the
  // former; owner gates arrive with §16.
  return reply.code(status).send({ code, gate, kind: 'registry-refusal', message, ...details });
}

export async function registerAuthoringRoutes(app: FastifyInstance, deps: AuthoringDeps): Promise<void> {
  const { pool, ownership, credentials } = deps;

  for (const credential of credentials) {
    if (credential.token.length < 32) throw new Error('authoring credentials must be at least 32 characters');
    if (credential.kind !== 'human' && !credential.principal) {
      throw new Error(`credential for ${credential.userId}: a ${credential.kind} needs a principal (§4.3)`);
    }
  }

  async function authenticate(request: FastifyRequest): Promise<Credential | null> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    const presented = Buffer.from(token);
    for (const credential of credentials) {
      const expected = Buffer.from(credential.token);
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) return credential;
    }
    // The table: looked up by hash, so a wrong token costs one indexed read
    // and a revoked one is simply absent (§15.2).
    if (deps.credentialStore && token.length >= 32) {
      const found = await deps.credentialStore.findByToken(token);
      if (found) {
        if (found.id) void deps.credentialStore.touch(found.id);
        return found;
      }
    }
    return null;
  }

  /**
   * The scope check — §15.2, §23 priority 7.
   *
   * One function on one choke point, so "a credential without publish cannot
   * publish under any endpoint or parameter combination" is a property of the
   * structure rather than of each handler's diligence.
   *
   * A REHEARSAL is the one deliberate exception (12 Sept 2026, Anto's ruling):
   * `POST …/publish?dry_run=true` needs register, not publish. The gate
   * findings it returns — Header completeness, additivity — are not what the
   * publish scope guards; the irreversible act is. An agent holding the
   * preparatory scopes alone must be able to converge on a publishable
   * document (§15.1) and hand it to the person who holds publish. Only the
   * literal string "true" is a rehearsal; anything else is the real act.
   */
  async function requireScope(request: FastifyRequest, reply: FastifyReply, scope: Scope): Promise<Authed | null> {
    const credential = await authenticate(request);
    if (!credential) {
      structuredError(reply, 401, 'auth.missing', 'auth', 'A bearer token is required (§15.1).');
      return null;
    }
    if (!credential.scopes.includes(scope)) {
      structuredError(reply, 403, 'auth.scope', 'auth', `This act requires the "${scope}" scope (§15.2).`, {
        required_scope: scope,
        held_scopes: credential.scopes,
      });
      return null;
    }
    return { credential };
  }

  function actorOf(credential: Credential) {
    return {
      actor: credential.userId,
      kind: credential.kind,
      ...(credential.principal ? { principal: credential.principal } : {}),
    } as const;
  }

  /**
   * The strict path: registration and publication.
   *
   * Spec §7.3 requires the owner's authorization to exist for these two acts,
   * and only the seam can answer. If Part One is unreachable, these BLOCK with
   * a structured 503 — §4.1 rule 2 names them as exactly the acts that do.
   */
  async function authorizeWrite(
    reply: FastifyReply,
    credential: Credential,
    name: string,
    intent: 'register' | 'publish',
  ): Promise<{ allocationId: string } | null> {
    let decision;
    try {
      decision = await authorizes(ownership, { userId: credential.userId, kind: credential.kind }, name, {
        intent,
      });
    } catch (error) {
      structuredError(reply, 503, 'seam.unavailable', 'authorization',
        `The allocation service is unavailable, and every act on a name requires its answer (spec §7.3, §4.1). Retry later; resolution continues to work.`,
        { name, cause: (error as Error).message });
      return null;
    }
    if (!decision.allowed) {
      structuredError(reply, 403, `authorization.${decision.reason}`, 'authorization', decision.detail, {
        name,
      });
      return null;
    }
    return { allocationId: decision.allocation_id };
  }

  /**
   * The edit path: deprecation, stewardship, release.
   *
   * Spec §7.3 (8 Sept revision) requires the owner's authorization for EVERY
   * act on a name — "registration, publication, Deprecation, a change to a
   * stewardship field, or release" — and only the seam can answer. So these
   * acts wait exactly as registration and publication do when the seam cannot
   * answer: a structured 503, nothing written. Reads are unaffected (§4.1).
   *
   * Until 12 Sept 2026 this path fell back to the name's recorded registrant
   * during a Part One outage. An outside review pointed out what that grants:
   * a member since removed, or a former holder's registrant after a transfer,
   * could act for as long as the seam was down — authority inferred from a
   * historical fact rather than established. Removed on Anto's ruling; the
   * intent is still "publish", because allocation state gates registration
   * only (§14).
   */
  async function authorizeEdit(
    reply: FastifyReply,
    credential: Credential,
    name: string,
  ): Promise<{ allocationId: string } | null> {
    return authorizeWrite(reply, credential, name, 'publish');
  }

  async function profileRow(name: string) {
    const { rows } = await pool.query<{
      id: string;
      discarded_at: Date | null;
    }>(
      // Live registrations only: a released row keeps the name's history and
      // blocks nothing (spec §7.3; migration 8).
      `SELECT id, discarded_at FROM profile WHERE name = $1 AND discarded_at IS NULL`,
      [name],
    );
    return rows[0] ?? null;
  }

  // --- PUT /<name> and PUT /<name>:draft ------------------------------------
  //
  // One URL per object (§15): the same path segment carries both, and the
  // parsed reference dispatches. PUT on the bare name registers it; PUT on
  // :draft replaces the Draft's content; PUT on :<n> is refused, because a
  // version is created by publication and never written directly.

  app.put<{ Params: { ref: string }; Body: unknown }>('/:ref', async (request, reply) => {
    const authed = await requireScope(request, reply, 'register');
    if (!authed) return;

    const { name, version } = splitReference(request.params.ref);

    if (version === 'unpublished') {
      return structuredError(reply, 405, 'unpublished.not_held', 'registration',
        'The Registry does not hold unpublished content (spec §7.3): your working copy lives with you, and enters the Registry only as the payload of POST /' + name + '/publish.');
    }
    if (version !== null) {
      return structuredError(reply, 405, 'method.not_registrable', 'grammar',
        'A version is created by publication, never by PUT (spec §6.2).');
    }
    const problem = nameProblem(name);
    if (problem) {
      return structuredError(reply, 400, `grammar.${problem}`, 'grammar',
        `"${name}" is not a registrable Profile name (${problem}).`);
    }

    const existing = await profileRow(name);
    if (existing) {
      // Idempotent: registering a name you hold is a no-op, not an error.
      const mine = await authorizeWrite(reply, authed.credential, name, 'register');
      if (!mine) return;
      return reply.code(200).send({ name, registered: true, existing: true });
    }

    const authz = await authorizeWrite(reply, authed.credential, name, 'register');
    if (!authz) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await registerName(client, actorOf(authed.credential), {
        name,
        allocationId: authz.allocationId,
        registeredBy: authed.credential.userId,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return reply.code(201).send({ name, registered: true });
  });

  // --- POST /operator/allocations — the one §9.2 operator act (Phase 0) -----
  //
  // Allocates a NEW Top Level Prefix, as an operator ruling in the §10.2
  // bootstrap's mold: evidence named, everything audited, policy consulted and
  // never overridden. Guarded by the 'operator' scope, which no authoring
  // credential carries by default. `dry_run=true` runs every check and
  // provably writes nothing.

  app.post<{
    Querystring: { dry_run?: string };
    Body: {
      tlp?: string;
      organization?: { name?: string; website?: string; contact_email?: string };
      evidence?: string;
      term_years?: number;
      notes?: string;
      member_user_id?: string;
    } | null;
  }>('/operator/allocations', async (request, reply) => {
    const authed = await requireScope(request, reply, 'operator');
    if (!authed) return;

    const body = request.body;
    if (!body || typeof body.tlp !== 'string' || typeof body.organization?.name !== 'string') {
      return structuredError(reply, 400, 'allocation.payload_required', 'allocation',
        'The ruling travels in the body: { tlp, organization: { name }, evidence, ... }.');
    }
    if (body.term_years !== undefined && (!Number.isInteger(body.term_years) || body.term_years < 1 || body.term_years > 100)) {
      return structuredError(reply, 400, 'allocation.term_invalid', 'allocation',
        'term_years is a whole number of years, 1 to 100 (§8.2).');
    }

    const allocateRequest = {
      tlp: body.tlp,
      organization: {
        name: body.organization.name,
        ...(body.organization.website ? { website: body.organization.website } : {}),
        ...(body.organization.contact_email ? { contactEmail: body.organization.contact_email } : {}),
      },
      evidence: body.evidence ?? '',
      ...(body.term_years !== undefined ? { termYears: body.term_years } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.member_user_id ? { memberUserId: body.member_user_id } : {}),
      actor: {
        id: authed.credential.userId,
        kind: authed.credential.kind,
        ...(authed.credential.principal ? { principal: authed.credential.principal } : {}),
      },
    };

    const dryRun = request.query.dry_run === 'true';
    if (dryRun) {
      const refusal = await checkAllocatable(pool, allocateRequest);
      if (refusal) {
        return structuredError(reply, refusal.code === 'tlp.already-allocated' ? 409 : 422,
          `allocation.${refusal.code}`, 'allocation', refusal.message, { ...refusal.details, dry_run: true });
      }
      return reply.code(200).send({
        allocatable: true,
        dry_run: true,
        tlp: allocateRequest.tlp,
        message: 'The ruling would apply. Nothing has changed.',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await allocateTlp(client, allocateRequest);
      if (!outcome.allocated) {
        await client.query('ROLLBACK');
        return structuredError(reply, outcome.code === 'tlp.already-allocated' ? 409 : 422,
          `allocation.${outcome.code}`, 'allocation', outcome.message, outcome.details ?? {});
      }
      await client.query('COMMIT');
      return reply.code(201).send({
        allocated: true,
        tlp: outcome.tlp,
        holder: outcome.organization.name,
        organization_created: outcome.organization.created,
        expires_at: outcome.expiresAt,
        membership: outcome.membership,
        href: `/${outcome.tlp}`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // --- DELETE /<name> — discard (§13.5). Only while never published. --------

  app.delete<{ Params: { ref: string } }>('/:ref', async (request, reply) => {
    const authed = await requireScope(request, reply, 'release');
    if (!authed) return;

    const { name, version } = splitReference(request.params.ref);
    if (version !== null) {
      return structuredError(reply, 405, 'immutability.version', 'immutability',
        'A published version is never deleted (spec §6.2, §9.3).');
    }

    const authz = await authorizeEdit(reply, authed.credential, name);
    if (!authz) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The discard guard trigger refuses if any version exists (spec §7.3).
      const { rows: discardedRows } = await client.query<{ discarded_at: Date }>(
        `UPDATE profile SET discarded_at = now() WHERE name = $1 AND discarded_at IS NULL
         RETURNING discarded_at`,
        [name],
      );
      const discarded = discardedRows[0];
      if (!discarded) {
        await client.query('ROLLBACK');
        return structuredError(reply, 404, 'registration.not_found', 'registration', `"${name}" is not registered.`);
      }
      await record(client, {
        actor: authed.credential.userId,
        actor_kind: authed.credential.kind,
        principal: authed.credential.principal ?? null,
        action: 'profile.discard', subject_type: 'profile', subject_id: name,
        after: { name, discarded_at: discarded.discarded_at.toISOString() },
        rationale: 'Draft discarded before any publication; the name is released (spec §7.3).',
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as Error).message.includes('permanent')) {
        return structuredError(reply, 409, 'immutability.name_permanent', 'immutability',
          `"${name}" has published versions and is permanent; only a Draft never published may be discarded (spec §7.3).`);
      }
      throw error;
    } finally {
      client.release();
    }

    return reply.code(204).send();
  });

  // --- POST /<name>/publish — the single act, WITH PAYLOAD (§13.4). ---------
  //
  // 8 Sept revision, §7.3: "Publication is the act by which a Profile's
  // content ENTERS the Registry" — the Registry SHALL NOT hold unpublished
  // content, so the document arrives in the request body, is checked, and is
  // either frozen or refused with nothing retained. The author's workspace is
  // the author's own; the Registry sees content only at this moment.

  app.post<{ Params: { ref: string }; Querystring: { dry_run?: string }; Body: unknown }>(
    '/:ref/publish',
    async (request, reply) => {
      // A rehearsal changes nothing and needs only register; the act itself
      // needs publish (see requireScope).
      const dryRunParam = request.query.dry_run;
      if (dryRunParam !== undefined && dryRunParam !== 'true' && dryRunParam !== 'false') {
        // "TRUE", "1", "yes" must not silently become the irreversible act.
        return structuredError(reply, 400, 'grammar.dry_run', 'grammar',
          'dry_run is "true" or "false"; anything else is refused rather than guessed, because the alternative is an irreversible publication.',
          { dry_run: dryRunParam });
      }
      const rehearsal = dryRunParam === 'true';
      const authed = await requireScope(request, reply, rehearsal ? 'register' : 'publish');
      if (!authed) return;

      const { name, version } = splitReference(request.params.ref);
      if (version !== null || nameProblem(name)) {
        return structuredError(reply, 400, 'grammar.name', 'grammar', 'Publish addresses the name, not a version.');
      }

      const authz = await authorizeWrite(reply, authed.credential, name, 'publish');
      if (!authz) return;

      const row = await profileRow(name);
      if (!row) {
        return structuredError(reply, 404, 'registration.not_found', 'registration', `"${name}" is not registered.`);
      }

      const body = request.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return structuredError(reply, 400, 'publish.payload_required', 'shape',
          'Publication carries the content: send the full 2026-shape document as the request body (spec §7.3). The Registry holds no unpublished content to publish from.');
      }

      // Parse the payload as a 2026-shape document.
      let profile: Profile;
      try {
        profile = parseProfileVersion(body as never, name);
      } catch (error) {
        return structuredError(reply, 422, 'publish.malformed', 'shape', (error as Error).message);
      }
      if (profile.name !== name) {
        return structuredError(reply, 422, 'header.name_mismatch', 'header',
          `The document's Header.Name is "${profile.name}"; it SHALL match the registered name "${name}" (spec §6.6, §7.3).`);
      }
      const content: ProfileVersion = profile.versions![0]!;

      // --- The Registry gates (§14, spec §7.3) — the only grounds for refusal.
      const findings: unknown[] = [];

      // Header completeness (spec §6.6, §9.4). Version/PubDate/Status are the
      // Registry's to assign at publication, so only the authored fields gate.
      const missing = missingHeaderFields({ ...profile, status: 'Unpublished' });
      for (const field of missing) {
        if (field === 'Version' || field === 'Pub Date' || field === 'Status') continue;
        findings.push({ code: 'header.missing_field', gate: 'header', field,
          message: `Header field "${field}" is REQUIRED (spec §6.6).` });
      }

      // At least one Property (spec §6.4, §7.3, §9.4).
      if (content.properties.length === 0) {
        findings.push({ code: 'properties.none', gate: 'properties',
          message: 'A Profile consists of one or more named Properties (spec §6.4); a Connection must be observable through its Properties even when Channels carry the traffic.' });
      }

      // One name space for Properties and Channels (spec §6.4, §6.5, §9.4).
      for (const dupe of duplicatePropertyNames(content)) {
        findings.push({ code: 'properties.duplicate_name', gate: 'properties', property: dupe,
          message: `"${dupe}" appears more than once; Properties and Channels share one name space (spec §6.4, §6.5).` });
      }

      // Additivity, against EVERY prior published version (spec §6.2).
      const priors = await pool.query<{ version: number; content: unknown }>(
        `SELECT v.version, v.content FROM profile_version v JOIN profile p ON p.id = v.profile_id
          WHERE p.name = $1 ORDER BY v.version`,
        [name],
      );
      const priorContents = priors.rows.map((r) => ({
        version: r.version,
        content: parseProfileVersion(r.content as never).versions![0]!,
      }));
      const result = checkAdditivityAgainstAll(content, priorContents);
      findings.push(...result.findings);

      const highestPrior = priors.rows.at(-1)?.version ?? 0;
      const dryRun = request.query.dry_run === 'true';

      if (findings.length > 0) {
        // "What fails it does not publish, and it retains nothing of it" (§7.3).
        return reply.code(422).send({
          publishable: false, dry_run: dryRun, name, findings,
          message: 'The document cannot be published as the next version. Nothing has changed, and nothing was retained.',
        });
      }

      if (dryRun) {
        // Every gate has run; nothing is written. §23 priority 7 proves it.
        return reply.code(200).send({
          publishable: true, dry_run: true, name,
          would_assign_version: highestPrior + 1,
          message: 'The document would publish. Nothing has changed, and nothing was retained.',
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const published = await publishVersion(client, actorOf(authed.credential), {
          profileId: row.id, name, profile, content,
          rationale: 'Published through the authoring API (§15); content carried in the publication itself (spec §7.3).',
        });
        await client.query('COMMIT');
        return reply.code(201).send({
          name, version: published.version, content_hash: published.contentHash,
          href: `/${name}:${published.version}`,
          note: 'The version is immutable and the name is now permanent (spec §6.2, §7.3). Your working copy remains yours; the Registry holds only what was published.',
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  // --- POST /<name>:<n>/deprecate (§13.5). Reversible in practice (§15.2). --

  app.post<{ Params: { ref: string } }>('/:ref/deprecate', async (request, reply) => {
    const authed = await requireScope(request, reply, 'deprecate');
    if (!authed) return;

    const { name, version } = splitReference(request.params.ref);
    if (typeof version !== 'number') {
      return structuredError(reply, 400, 'grammar.version', 'grammar', 'Deprecation addresses one published version.');
    }
    const authz = await authorizeEdit(reply, authed.credential, name);
    if (!authz) return;

    const { rows } = await pool.query<{ id: string }>(
      `SELECT v.id FROM profile_version v JOIN profile p ON p.id = v.profile_id
        WHERE p.name = $1 AND v.version = $2`,
      [name, version],
    );
    if (!rows[0]) return structuredError(reply, 404, 'version.not_found', 'version', `No version ${version} of "${name}".`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await deprecateVersion(client, actorOf(authed.credential), rows[0].id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return reply.send({ name, version, status: 'deprecated',
      note: 'Excluded from selection for new Connections; existing Connections unaffected (spec §6.2).' });
  });

  // --- PATCH /<name>:<n>/header — Owner and Website only (spec §6.4). -------

  app.patch<{ Params: { ref: string }; Body: { Owner?: string; Website?: string } & Record<string, unknown> }>(
    '/:ref/header',
    async (request, reply) => {
      const authed = await requireScope(request, reply, 'steward');
      if (!authed) return;

      const { name, version } = splitReference(request.params.ref);
      if (typeof version !== 'number') {
        return structuredError(reply, 400, 'grammar.version', 'grammar', 'Stewardship addresses one published version.');
      }
      const body = request.body ?? {};
      const disallowed = Object.keys(body).filter((k) => k !== 'Owner' && k !== 'Website');
      if (disallowed.length > 0) {
        return structuredError(reply, 422, 'header.fixed_by_publication', 'immutability',
          `Only Owner and Website may change after publication (spec §6.4).`, { rejected_fields: disallowed });
      }

      const authz = await authorizeEdit(reply, authed.credential, name);
      if (!authz) return;

      const { rows } = await pool.query<{ id: string }>(
        `SELECT v.id FROM profile_version v JOIN profile p ON p.id = v.profile_id
          WHERE p.name = $1 AND v.version = $2`, [name, version]);
      if (!rows[0]) return structuredError(reply, 404, 'version.not_found', 'version', `No version ${version} of "${name}".`);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await updateStewardship(client, actorOf(authed.credential), rows[0].id, {
          ...(body.Owner !== undefined ? { owner: body.Owner } : {}),
          ...(body.Website !== undefined ? { website: body.Website } : {}),
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return reply.send({ name, version, updated: Object.keys(body) });
    },
  );

}
