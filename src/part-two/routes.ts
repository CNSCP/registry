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
 * CREDENTIAL SCOPES (§15.2). Part Two has exactly two irreversible acts —
 * publication, and disclosure to public — so credentials are scoped
 * `draft:write · publish · deprecate · disclose`, and a machine author
 * normally holds draft:write alone: the whole of the work, none of the damage.
 * §23 priority 7 is the test that this holds under every endpoint.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';

import { record } from '../audit.ts';
import { nameProblem } from '../names.ts';
import { authorizes } from '../part-one/authorizes.ts';
import type { OwnershipStore } from '../part-one/types.ts';
import { checkAdditivity } from '../profile/additivity.ts';
import { missingHeaderFields, duplicatePropertyNames } from '../profile/conformance.ts';
import type { Profile, ProfileVersion } from '../profile/model.ts';
import { parseProfileVersion } from '../profile/spec2026.ts';
import { publishVersion, registerName, deprecateVersion, updateStewardship } from '../profile/store.ts';
import { splitReference } from '../part-three/routes.ts';

export type Scope = 'draft:write' | 'publish' | 'deprecate' | 'disclose';

export type Credential = {
  /** The bearer token value. */
  token: string;
  /** app_user id this credential acts as — the seam resolves the rest. */
  userId: string;
  kind: 'human' | 'service' | 'agent';
  /** Required for service/agent: the human behind it (§4.3, §15.1). */
  principal?: string;
  scopes: Scope[];
};

export type AuthoringDeps = {
  pool: pg.Pool;
  ownership: OwnershipStore;
  /** Phase 0: a static credential table. OIDC and issuance are Phase 2. */
  credentials: Credential[];
  /** The list of Realms the owner operates — the trapdoor's boundary (§13.3). */
  operatedRealms?: string[];
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
  const operatedRealms = new Set(deps.operatedRealms ?? []);

  for (const credential of credentials) {
    if (credential.token.length < 32) throw new Error('authoring credentials must be at least 32 characters');
    if (credential.kind !== 'human' && !credential.principal) {
      throw new Error(`credential for ${credential.userId}: a ${credential.kind} needs a principal (§4.3)`);
    }
  }

  function authenticate(request: FastifyRequest): Credential | null {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const presented = Buffer.from(header.slice(7));
    for (const credential of credentials) {
      const expected = Buffer.from(credential.token);
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) return credential;
    }
    return null;
  }

  /**
   * The scope check — §15.2, §23 priority 7.
   *
   * One function on one choke point, so "a draft:write credential cannot
   * publish, deprecate, or disclose under any endpoint or parameter
   * combination" is a property of the structure rather than of each handler's
   * diligence. dry_run is NOT an exemption: rehearsing publication still
   * requires the publish scope, or the scope would leak what it guards.
   */
  function requireScope(request: FastifyRequest, reply: FastifyReply, scope: Scope): Authed | null {
    const credential = authenticate(request);
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
        `The allocation service is unavailable, and ${intent === 'register' ? 'registration' : 'publication'} requires its answer (spec §7.3, §4.1). Retry later; Draft edits and reads continue to work.`,
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
   * The edit path: Draft writes, deprecation, stewardship, disclosure, discard.
   *
   * §4.1 rule 2: "Part Two must remain able to serve reads and edits when Part
   * One is unavailable; only registration and publication block." So the seam
   * is consulted as always while it answers — an outage widens nothing in
   * normal operation — and on failure the check degrades to something local:
   * the recorded registrant of the name may continue working on it. Anyone
   * else waits with the seam, and the degraded grant is written to the audit
   * chain by the act it permits.
   */
  async function authorizeEdit(
    reply: FastifyReply,
    credential: Credential,
    name: string,
  ): Promise<{ degraded: boolean } | null> {
    try {
      const decision = await authorizes(ownership, { userId: credential.userId, kind: credential.kind }, name, {
        intent: 'publish', // edit-class: allocation state does not gate (§14)
      });
      if (!decision.allowed) {
        structuredError(reply, 403, `authorization.${decision.reason}`, 'authorization', decision.detail, { name });
        return null;
      }
      return { degraded: false };
    } catch {
      const { rows } = await pool.query<{ registered_by: string | null }>(
        `SELECT registered_by FROM profile WHERE name = $1 AND discarded_at IS NULL`,
        [name],
      );
      if (rows[0] && rows[0].registered_by === credential.userId) {
        return { degraded: true };
      }
      structuredError(reply, 503, 'seam.unavailable', 'authorization',
        'The allocation service is unavailable. The registrant of a name may continue editing during the outage; other authorization requires the seam (§4.1 rule 2).',
        { name });
      return null;
    }
  }

  async function profileRow(name: string) {
    const { rows } = await pool.query<{
      id: string;
      draft_content: unknown;
      draft_disclosure: 'private' | 'authorized' | 'public';
      discarded_at: Date | null;
    }>(
      `SELECT id, draft_content, draft_disclosure, discarded_at FROM profile WHERE name = $1`,
      [name],
    );
    const row = rows[0];
    return row && !row.discarded_at ? row : null;
  }

  // --- PUT /<name> and PUT /<name>:draft ------------------------------------
  //
  // One URL per object (§15): the same path segment carries both, and the
  // parsed reference dispatches. PUT on the bare name registers it; PUT on
  // :draft replaces the Draft's content; PUT on :<n> is refused, because a
  // version is created by publication and never written directly.

  app.put<{ Params: { ref: string }; Body: unknown }>('/:ref', async (request, reply) => {
    const authed = requireScope(request, reply, 'draft:write');
    if (!authed) return;

    const { name, version } = splitReference(request.params.ref);

    if (version === 'draft') return putDraft(name, request.body, authed, reply);

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

    return reply.code(201).send({ name, registered: true, draft: `/${name}:draft` });
  });

  // --- DELETE /<name> — discard (§13.5). Only while never published. --------

  app.delete<{ Params: { ref: string } }>('/:ref', async (request, reply) => {
    const authed = requireScope(request, reply, 'draft:write');
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
      const { rowCount } = await client.query(
        `UPDATE profile SET discarded_at = now() WHERE name = $1 AND discarded_at IS NULL`,
        [name],
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return structuredError(reply, 404, 'registration.not_found', 'registration', `"${name}" is not registered.`);
      }
      await record(client, {
        actor: authed.credential.userId,
        actor_kind: authed.credential.kind,
        principal: authed.credential.principal ?? null,
        action: 'profile.discard', subject_type: 'profile', subject_id: name,
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

  // --- the Draft write (§13.2) ----------------------------------------------
  //
  // "Mutable without restriction" (spec §6.2): no gate runs here. The Draft is
  // not a contract, and — while private — visible to no one else, which is
  // exactly the property an autonomous author needs (§15.1). The gates run at
  // publication, and dry_run lets an agent rehearse them at any time.

  async function putDraft(name: string, body: unknown, authed: Authed, reply: FastifyReply): Promise<unknown> {
    if (nameProblem(name)) {
      return structuredError(reply, 400, 'grammar.name', 'grammar', `"${name}" is not a Profile name.`);
    }
    const authz = await authorizeEdit(reply, authed.credential, name);
    if (!authz) return;

    const row = await profileRow(name);
    if (!row) {
      return structuredError(reply, 404, 'registration.not_found', 'registration',
        `"${name}" is not registered. PUT /${name} first — registration claims the name and creates the Draft (§13.1).`);
    }
    if (body === undefined || body === null) {
      return structuredError(reply, 400, 'draft.body_required', 'draft', 'Send the Draft content as the request body.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE profile SET draft_content = $2::jsonb, draft_modified = now() WHERE id = $1`,
        [row.id, JSON.stringify(body)],
      );
      await record(client, {
        actor: authed.credential.userId, actor_kind: authed.credential.kind,
        principal: authed.credential.principal ?? null,
        action: 'profile.draft', subject_type: 'profile', subject_id: row.id,
        after: { name, draft_modified: true },
        rationale: null,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return reply.send({ name, draft: 'updated', note: 'The Draft is not a contract; publish when ready (§13.4).' });
  }

  // --- POST /<name>/publish — the single act (§13.4). -----------------------

  app.post<{ Params: { ref: string }; Querystring: { dry_run?: string } }>(
    '/:ref/publish',
    async (request, reply) => {
      const authed = requireScope(request, reply, 'publish');
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
      if (row.draft_content === null || row.draft_content === undefined) {
        return structuredError(reply, 409, 'draft.empty', 'draft', 'The Draft is empty; there is nothing to publish.');
      }

      // Parse the Draft as a 2026-shape document.
      let profile: Profile;
      try {
        profile = parseProfileVersion(row.draft_content as never, name);
      } catch (error) {
        return structuredError(reply, 422, 'draft.malformed', 'shape', (error as Error).message);
      }
      if (profile.name !== name) {
        return structuredError(reply, 422, 'header.name_mismatch', 'header',
          `The Draft's Header.Name is "${profile.name}"; it SHALL match the registered name "${name}" (spec §6.4).`);
      }
      const content: ProfileVersion = profile.versions![0]!;

      // --- The Registry gates (§14) — the only grounds for refusal. ---------
      const findings: unknown[] = [];

      // Header completeness (spec §6.4, §9.4). Version/PubDate/Status are the
      // Registry's to assign at publication, so only the authored fields gate.
      const missing = missingHeaderFields({ ...profile, status: 'Draft' });
      for (const field of missing) {
        if (field === 'Version' || field === 'Pub Date' || field === 'Status') continue;
        findings.push({ code: 'header.missing_field', gate: 'header', field,
          message: `Header field "${field}" is REQUIRED (spec §6.4).` });
      }

      // Property-name uniqueness (spec §6.3, §9.4).
      for (const dupe of duplicatePropertyNames(content)) {
        findings.push({ code: 'properties.duplicate_name', gate: 'properties', property: dupe,
          message: `"${dupe}" appears in both roles or twice; names are unique across both roles (spec §6.3).` });
      }

      // Additivity, where prior versions exist (spec §6.2, §23 priority 2).
      const prior = await pool.query<{ version: number; content: unknown }>(
        `SELECT v.version, v.content FROM profile_version v JOIN profile p ON p.id = v.profile_id
          WHERE p.name = $1 ORDER BY v.version DESC LIMIT 1`,
        [name],
      );
      if (prior.rows[0]) {
        const priorProfile = parseProfileVersion(prior.rows[0].content as never);
        const result = checkAdditivity(content, priorProfile.versions![0]!, prior.rows[0].version);
        findings.push(...result.findings);
      }

      const dryRun = request.query.dry_run === 'true';
      if (findings.length > 0) {
        return reply.code(422).send({
          publishable: false, dry_run: dryRun, name, findings,
          message: 'The Draft cannot be published as the next version. Nothing has changed.',
        });
      }

      if (dryRun) {
        // Every gate has run; nothing is written. §23 priority 7 proves it.
        return reply.code(200).send({
          publishable: true, dry_run: true, name,
          would_assign_version: (prior.rows[0]?.version ?? 0) + 1,
          message: 'The Draft would publish. Nothing has changed.',
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const published = await publishVersion(client, actorOf(authed.credential), {
          profileId: row.id, name, profile, content,
          rationale: 'Published through the authoring API (§15).',
        });
        await client.query('COMMIT');
        return reply.code(201).send({
          name, version: published.version, content_hash: published.contentHash,
          href: `/${name}:${published.version}`,
          note: 'The version is immutable and the name is now permanent (spec §6.2, §7.3). The Draft persists as your workspace.',
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
    const authed = requireScope(request, reply, 'deprecate');
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
      const authed = requireScope(request, reply, 'draft:write');
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

  // --- POST /<name>:draft/disclosure — the trapdoor (§13.3). ----------------

  app.post<{ Params: { ref: string }; Body: { realm?: string; confirm_public?: boolean } }>(
    '/:ref/disclosure',
    async (request, reply) => {
      const authed = requireScope(request, reply, 'disclose');
      if (!authed) return;

      const { name, version } = splitReference(request.params.ref);
      if (version !== 'draft') {
        return structuredError(reply, 400, 'grammar.draft', 'grammar', 'Disclosure addresses the Draft.');
      }
      const realm = request.body?.realm;
      if (!realm || typeof realm !== 'string') {
        return structuredError(reply, 400, 'disclosure.realm_required', 'disclosure', 'Name the Realm to authorize.');
      }

      const authz = await authorizeEdit(reply, authed.credential, name);
      if (!authz) return;
      const row = await profileRow(name);
      if (!row) return structuredError(reply, 404, 'registration.not_found', 'registration', `"${name}" is not registered.`);

      const operated = operatedRealms.has(realm);

      if (!operated && request.body?.confirm_public !== true) {
        // The confirmation challenge (§15). Accepting makes the Draft public to
        // everyone, irreversibly — the API demands the caller say so.
        return reply.code(409).send({
          code: 'disclosure.confirmation_required', gate: 'disclosure',
          message:
            `"${realm}" is not on your operated-Realms list. Authorizing it makes the Draft of "${name}" ` +
            `answerable to ANY party thereafter, irreversibly (spec §7.3). ` +
            `Repeat the request with confirm_public: true to proceed.`,
          irreversible: true,
        });
      }

      const target = operated ? 'authorized' : 'public';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The trapdoor trigger enforces irreversibility; this only moves forward.
        await client.query(
          `UPDATE profile SET draft_disclosure = $2::draft_disclosure WHERE id = $1
             AND draft_disclosure <> 'public'`,
          [row.id, target],
        );
        await record(client, {
          actor: authed.credential.userId, actor_kind: authed.credential.kind,
          principal: authed.credential.principal ?? null,
          action: 'profile.disclose', subject_type: 'profile', subject_id: row.id,
          after: { name, realm, disclosure: row.draft_disclosure === 'public' ? 'public' : target },
          rationale: operated
            ? `Realm "${realm}" is operated by the owner; disclosure is scoped (§13.3).`
            : `Realm "${realm}" is not operated by the owner. Sharing is disclosure: the Draft is public to any party, irreversibly (spec §7.3).`,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      return reply.send({
        name, realm,
        disclosure: row.draft_disclosure === 'public' ? 'public' : target,
        ...(target === 'public' ? { irreversible: true } : {}),
      });
    },
  );
}
