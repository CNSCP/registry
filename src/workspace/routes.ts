/**
 * The workspace surface — design §20.3.
 *
 *   GET    /<name>:unpublished   the form, as the author's answer (open, like resolution)
 *   PUT    /<name>:unpublished   save the form               (the workspace credential; If-Match)
 *   DELETE /<name>:unpublished   remove the form             (the workspace credential)
 *   GET    /workspace            every form this host holds  (open)
 *
 * And, where `test.*` is admitted, the rest of a `test` name's lifecycle on
 * this host only (§20.3, "`test.*` names on a workspace host"):
 *
 *   PUT    /test.<…>             register it here            (the workspace credential)
 *   DELETE /test.<…>             release it, and its form    (the workspace credential)
 *   GET    /test.<…>             its working document        (open)
 *   GET    /test.<…>/registration                            (open)
 *   POST   /test.<…>/lint        contract lint, advisory     (the workspace credential)
 *   GET    /test.<…>:<n>, POST /test.<…>/publish, and every other act:
 *                                refused here — a test name never has a version
 *
 * None of these is ever relayed upstream, even by a forwarder: canon refuses
 * `test` everywhere, and nothing about a test name is canon's business.
 *
 * Mounted ONLY on a host that runs a workspace beside its instance; canon
 * never mounts it and never sets the configuration that would. The Registry
 * surface on the same host is unchanged by its presence: `/<name>` and
 * `/<name>:<n>` answer as canon does, byte for byte, in every machine
 * representation; the `/profiles/` alias never serves a form; the feed never
 * carries one. What this surface adds is the AUTHOR'S answer at the one
 * reference form the Registry never resolves (spec §7.2), and a pill and a
 * link on the human pages.
 *
 * Every answer from here is marked so that nothing downstream can mistake it
 * for a version: `x-cp-surface: workspace`, `x-cp-status: unpublished`,
 * `Cache-Control: no-store`, an ETag that is the content hash and nothing
 * that claims immutability — no Content-Digest, no `immutable`. The document
 * carries `Status: Unpublished` and no Version. That marking is what makes
 * the non-capture argument of §20.3 hold: a draft can never be cached,
 * matched or selected as a version, so conveyance never becomes publication
 * by other means.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db.ts';
import { MEDIA, etagMatches, negotiate } from '../part-three/http.ts';
import { documentSections, enableWorkspaceNav, escape, page, splitReference, versionStrip, type UnpublishedPill, type WorkspaceHooks } from '../part-three/routes.ts';
import { resolveName, type VersionSummary } from '../part-three/store.ts';
import { nameProblem, tlpOf } from '../names.ts';
import { lint, tally } from '../profile/lint.ts';
import { parseProfileVersion } from '../profile/spec2026.ts';
import { instanceRefusal } from '../distribution/routes.ts';
import type { WriteHandler } from '../distribution/forward.ts';
import { mayWriteWorkspace, signature, type WorkspaceCredential } from './credential.ts';
import { buildCarrier, fetchLink as realFetchLink, incomingFromLink, originOf, parseIncoming, parseLink, type IncomingSet, type LinkFetch } from './carrier.ts';
import { importSet, type ImportRow } from './share.ts';
import {
  darkForms,
  formETag,
  getForm,
  heldForms,
  holders,
  listForms,
  movedOnSince,
  presentForm,
  qualifies,
  registerTestName,
  releaseTestName,
  removeForm,
  saveForm,
  sharedReadOnly,
  testRegistration,
  testRegistrations,
  type DarkForm,
  type Qualification,
  type WorkspaceConfig,
  type WorkspaceForm,
} from './store.ts';

export type WorkspaceDeps = {
  db: Queryable;
  config: WorkspaceConfig;
  credentials: readonly WorkspaceCredential[];
  /** The authoritative host, named in the refusal a write to a Registry path still gets here. */
  upstream: string;
  /**
   * Bring the mirror up to date, if this host follows one (§20.1 `sync`).
   *
   * A name is registered at the AUTHORITATIVE store, and this host learns of
   * it on its next sync — up to a sync interval later. So an author who has
   * just claimed a name and turns to save its form would be told the name is
   * not registered, which is false, and would be told it by the host that is
   * merely behind. `not-registered` is the one refusal here that a stale
   * mirror can invent, so it is the one refusal worth spending an upstream
   * call to be sure of: the workspace catches up once and asks again before
   * refusing. Nothing is trusted that was not verified — this is the ordinary
   * follower path (§20.1), hash checks and all.
   */
  catchUp?: () => Promise<void>;
  /**
   * What a non-`GET` on a REGISTRY path gets when it arrives at one of the
   * workspace's own routes (`PUT`/`DELETE /<ref>` with a ref that is not
   * `:unpublished`). The default is §4.4's refusal naming the authoritative
   * host; a forwarder relays it instead (§20.3). Either way the workspace
   * itself never acts on the namespace.
   */
  onRegistryWrite?: WriteHandler;
  html?: boolean;
  /** The organization that runs this host, as canon records it (INSTANCE_OPERATOR); named in carriers. */
  operator?: string | null;
  /** This host's public origin, when the request cannot be trusted to say (PUBLIC_URL). Otherwise read from the request. */
  publicUrl?: string;
  /** Admit plain-HTTP Share links (WORKSPACE_IMPORT_HTTP) — for hosts on a developer's machine only. */
  allowHttpLinks?: boolean;
  /** How a link is fetched; the real fetch unless a test supplies one. */
  fetchLink?: LinkFetch;
  /** PUBLIC_BASE_PATH, so the Share link shown is the one a partner can open. */
  basePath?: string;
};

/** The reserved dotless path for the index of forms a host holds (§4.4 routing rule). */
export const WORKSPACE_PATH = '/workspace';

export type Workspace = {
  /** For `registerResolutionRoutes({ workspace })`. */
  hooks: WorkspaceHooks;
  /** Mount the write routes and the index. After the resolution routes, before the instance refusals. */
  register(app: FastifyInstance): void;
};

function refusal(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace');
  return reply.code(status).send({ code, gate: 'workspace', kind: 'workspace-refusal', message, ...details });
}

function qualificationRefusal(reply: FastifyReply, q: Exclude<Qualification, { ok: true }>): FastifyReply {
  const status = q.reason === 'malformed' ? 400 : q.reason === 'not-registered' || q.reason === 'test-not-registered' ? 404 : 403;
  return refusal(reply, status, `workspace.${q.reason}`, q.detail);
}

/** The pill's note: where the form stands against what is published (§20.3). */
async function noteFor(db: Queryable, form: WorkspaceForm, q: Qualification): Promise<string | null> {
  if (q.ok && q.kind === 'test') return 'test';
  if (q.ok && q.kind === 'shared') return 'shared';
  const moved = await movedOnSince(db, form);
  if (!moved) return null;
  return moved.same ? `same as v${moved.version}` : `moved on since v${moved.version}`;
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  const { db, config, credentials, upstream } = deps;
  const renderHtml = deps.html ?? true;
  const onRegistryWrite: WriteHandler = deps.onRegistryWrite ?? (async (_request, reply) => instanceRefusal(reply, upstream));
  const linkFetch: LinkFetch = deps.fetchLink ?? realFetchLink;
  const basePath = (deps.basePath ?? '').replace(/\/+$/, '');

  function mark(reply: FastifyReply, form: WorkspaceForm): void {
    reply
      .header('cache-control', 'no-store')
      .header('vary', 'Accept')
      .header('etag', formETag(form))
      .header('x-cp-surface', 'workspace')
      .header('x-cp-status', 'unpublished');
    // A shared copy says whose it is on every answer, so a re-share by link
    // keeps the chain of hands (§20.3, "Sharing a form").
    if (form.kind === 'shared') {
      reply.header('x-cp-shared-from', form.origin ?? 'unknown');
      if (form.via.length > 0) reply.header('x-cp-shared-via', form.via.join(', '));
    }
  }

  /** This host's origin as a partner reaches it: PUBLIC_URL, or what the request says. */
  function hostOrigin(request: FastifyRequest): string {
    if (deps.publicUrl) return originOf(deps.publicUrl) ?? deps.publicUrl;
    const forwarded = request.headers['x-forwarded-proto'];
    const proto = (typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : '') || request.protocol;
    return `${proto}://${request.host}`;
  }

  /** The Share link for a form: its own address on this host. */
  function shareLink(request: FastifyRequest, name: string): string {
    const path = tlpOf(name) === 'test' ? `/${name}` : `/${name}:unpublished`;
    return `${hostOrigin(request)}${basePath}${path}`;
  }

  const hooks: WorkspaceHooks = {
    async unpublished(name, representation, reply) {
      const form = await getForm(db, name);
      if (!form) return false;
      const q = await qualifies(db, config, name, form.kind);
      if (!q.ok) return false;

      mark(reply, form);
      if (etagMatches(reply.request.headers['if-none-match'], formETag(form))) {
        reply.code(304).send();
        return true;
      }

      const presented = presentForm(form);
      if (representation === 'html' && renderHtml) {
        const registered = await resolveName(db, name);
        const note = await noteFor(db, form, q);
        reply.type(MEDIA.html).send(renderForm(form, presented.document, q, registered?.versions ?? [], note, { link: shareLink(reply.request, name) }));
        return true;
      }
      reply.type(MEDIA.spec2026).send(presented.text);
      return true;
    },

    async testName(name, version, representation, reply) {
      // Not admitted, or not registered here: the Registry's own answer
      // (canon's 404) stands, so a host without the setting is canon's twin.
      if (!config.test || nameProblem(name)) return false;
      const registration = await testRegistration(db, name);
      if (!registration) return false;

      if (version !== null) {
        refusal(reply, 404, 'workspace.test-has-no-versions',
          `"${name}" is a test name, which never has a version (spec §7.1): resolve it by its bare name, cp:${name}, for the working document.`,
          { name, href: `/${name}` });
        return true;
      }

      const form = await getForm(db, name);
      if (!form) {
        if (representation === 'html' && renderHtml) {
          reply.code(404).header('cache-control', 'no-store').header('x-cp-surface', 'workspace');
          reply.type(MEDIA.html).send(renderTestUnsaved(name, registration.registered_at));
          return true;
        }
        refusal(reply, 404, 'workspace.test-nothing-saved',
          `"${name}" is registered on this host but nothing has been saved under it yet: PUT /${name}:unpublished with the working document and the workspace credential.`,
          { name, registered: true });
        return true;
      }

      mark(reply, form);
      if (etagMatches(reply.request.headers['if-none-match'], formETag(form))) {
        reply.code(304).send();
        return true;
      }
      const presented = presentForm(form);
      if (representation === 'html' && renderHtml) {
        const tq: Qualification = form.kind === 'shared' ? { ok: true, kind: 'shared', holder: null } : { ok: true, kind: 'test' };
        reply.type(MEDIA.html).send(renderForm(form, presented.document, tq, [], form.kind === 'shared' ? 'shared' : 'test', { bare: true, link: shareLink(reply.request, name) }));
        return true;
      }
      reply.type(MEDIA.spec2026).send(presented.text);
      return true;
    },

    async testRegistration(name, reply) {
      if (!config.test || nameProblem(name)) return false;
      const registration = await testRegistration(db, name);
      if (!registration) return false;
      reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace');
      reply.send({ registered: true, name, since: registration.registered_at, versions: [] });
      return true;
    },

    async held(names) {
      const out = new Map<string, UnpublishedPill>();
      for (const name of await heldForms(db, names)) {
        const form = await getForm(db, name);
        if (!form) continue;
        const q = await qualifies(db, config, name, form.kind);
        if (!q.ok) continue; // dark: released or transferred away; reported, never deleted
        out.set(name, { href: `/${name}:unpublished`, note: await noteFor(db, form, q) });
      }
      return out;
    },

    async summary() {
      const forms = await listForms(db, config);
      const dark = forms.length - forms.filter((f) => f.qualification.ok).length;
      return {
        orgs: await holders(db, config),
        test: config.test,
        forms: forms.filter((f) => f.qualification.ok).length,
        // Held but no longer servable under this host's own rules (§20.3).
        // Surfaced here because a host that has quietly stopped serving
        // something should say so where an operator already looks.
        ...(dark > 0 ? { dark } : {}),
        index: WORKSPACE_PATH,
      };
    },
  };

  function register(app: FastifyInstance): void {
    enableWorkspaceNav();

    // The document arrives as the 2026 shape; accept its own media type as
    // well as plain JSON. A RegExp key so the `profile=2026` parameter matches.
    if (!app.hasContentTypeParser(/^application\/cp\+json/)) {
      app.addContentTypeParser(/^application\/cp\+json/, { parseAs: 'string' }, (_request, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch (error) {
          done(error as Error, undefined);
        }
      });
    }

    function authenticate(request: FastifyRequest, reply: FastifyReply): WorkspaceCredential | null {
      const credential = mayWriteWorkspace(credentials, request.headers.authorization);
      if (!credential) {
        reply.header('www-authenticate', 'Bearer realm="workspace"');
        refusal(reply, 401, 'workspace.auth', 'Saving or removing an unpublished form takes the workspace credential, as a bearer token (§20.3).');
      }
      return credential;
    }

    /** Is this a `test` name this host answers for itself? Only where admitted; otherwise it is canon's to refuse. */
    function localTest(name: string): boolean {
      return config.test && name.includes('.') && tlpOf(name) === 'test';
    }

    app.put<{ Params: { ref: string } }>('/:ref', async (request, reply) => {
      const { name, version } = splitReference(request.params.ref);
      if (version !== 'unpublished' && localTest(name)) return testRegister(request, reply, name, version);
      if (version !== 'unpublished') return onRegistryWrite(request, reply);

      const credential = authenticate(request, reply);
      if (!credential) return reply;

      const held = await getForm(db, name);
      if (held?.kind === 'shared') {
        const r = sharedReadOnly(held);
        return refusal(reply, 409, `workspace.${r.refused}`, r.detail, { origin: held.origin });
      }

      let q = await qualifies(db, config, name);
      if (!q.ok && q.reason === 'not-registered' && deps.catchUp) {
        await deps.catchUp();
        q = await qualifies(db, config, name);
      }
      if (!q.ok) return qualificationRefusal(reply, q);

      const ifMatch = request.headers['if-match'];
      const result = await saveForm(db, name, request.body, {
        ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined,
        by: signature(credential),
      });
      if ('refused' in result) {
        const status =
          result.refused === 'precondition-required' ? 428
          : result.refused === 'precondition-failed' || result.refused === 'nothing-to-match' ? 412
          : result.refused === 'shared-copy-read-only' ? 409
          : 400;
        return refusal(reply, status, `workspace.${result.refused}`, result.detail, 'current' in result ? { current: result.current } : {});
      }

      mark(reply, result.form);
      return reply.code(result.created ? 201 : 200).send({
        name,
        href: `/${name}:unpublished`,
        content_hash: result.form.content_hash,
        updated_at: result.form.updated_at,
        updated_by: result.form.updated_by,
        held_as: q.kind === 'held' ? q.org.name : 'test',
        created: result.created,
      });
    });

    app.delete<{ Params: { ref: string } }>('/:ref', async (request, reply) => {
      const { name, version } = splitReference(request.params.ref);
      if (version !== 'unpublished' && localTest(name)) return testRelease(request, reply, name, version);
      if (version !== 'unpublished') return onRegistryWrite(request, reply);

      const credential = authenticate(request, reply);
      if (!credential) return reply;

      const ifMatch = request.headers['if-match'];
      const result = await removeForm(db, name, { ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined });
      if ('refused' in result) {
        if (result.refused === 'not-found') return refusal(reply, 404, 'workspace.not-found', `This host holds no unpublished form for "${name}".`);
        return refusal(reply, 412, `workspace.${result.refused}`, result.detail, 'current' in result ? { current: result.current } : {});
      }
      return reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace').code(204).send();
    });

    // --- test.* acts, on this host only (§20.3) -----------------------------

    async function testRegister(request: FastifyRequest, reply: FastifyReply, name: string, version: number | null): Promise<FastifyReply> {
      const credential = authenticate(request, reply);
      if (!credential) return reply;
      if (version !== null) return noVersions(reply, name);
      const problem = nameProblem(name);
      if (problem) return refusal(reply, 400, `workspace.malformed`, `"${name}" is not a registrable Profile name (${problem}).`);

      // No body is read, as at canon: registration claims a name and nothing
      // else, and the working document is saved at :unpublished.
      const { created } = await registerTestName(db, name, signature(credential));
      reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace');
      return reply.code(created ? 201 : 200).send({ name, registered: true, ...(created ? {} : { existing: true }) });
    }

    async function testRelease(request: FastifyRequest, reply: FastifyReply, name: string, version: number | null): Promise<FastifyReply> {
      const credential = authenticate(request, reply);
      if (!credential) return reply;
      if (version !== null) return noVersions(reply, name);
      if (!(await releaseTestName(db, name))) {
        return refusal(reply, 404, 'workspace.test-not-registered', `"${name}" is not registered on this host, so there is nothing to release.`);
      }
      return reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace').code(204).send();
    }

    function noVersions(reply: FastifyReply, name: string): FastifyReply {
      return refusal(reply, 404, 'workspace.test-has-no-versions',
        `"${name}" is a test name, which never has a version (spec §7.1).`, { name, href: `/${name}` });
    }

    // Every other act on a Profile path. For a test name this host answers;
    // for anything else it is a Registry act, refused or relayed exactly as
    // the fallthrough would (§4.4, §20.3).
    app.route<{ Params: { ref: string; '*': string } }>({
      method: ['POST', 'PATCH'],
      url: '/:ref/*',
      handler: async (request, reply) => {
        const { name, version } = splitReference(request.params.ref);
        if (version === 'unpublished' || !localTest(name)) return onRegistryWrite(request, reply);

        const credential = authenticate(request, reply);
        if (!credential) return reply;
        if (version !== null) return noVersions(reply, name);
        if (!(await testRegistration(db, name))) {
          return refusal(reply, 404, 'workspace.test-not-registered', `"${name}" is not registered on this host.`);
        }

        const act = request.params['*'];
        if (request.method === 'POST' && act === 'lint') {
          const body = request.body;
          if (body === undefined || body === null || typeof body !== 'object') {
            return refusal(reply, 400, 'workspace.not-a-document', 'Lint reads the candidate document: send the full 2026-shape document as the request body.');
          }
          let profile;
          try {
            profile = parseProfileVersion(body as never, name);
          } catch (error) {
            return refusal(reply, 422, 'workspace.lint-malformed', (error as Error).message);
          }
          // No priors: a test name has never published anything to be additive
          // against. And no findings that speak only of publication (§20.3).
          const findings = lint(profile, { priors: [], localTest: true });
          reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace');
          return reply.code(200).send({
            name,
            lint: { findings, tally: tally(findings) },
            advisory: true,
            message: 'Lint is advisory (§16). A test name is never published, so no finding here is ever a refusal of anything.',
          });
        }

        return refusal(reply, 409, 'workspace.test-never-published',
          `"${name}" is a test name: it is never published, anywhere (spec §7.1), so there is nothing to ${act === 'publish' ? 'publish — or rehearse publishing' : act}. ` +
            'When the Profile has settled, register its real name at the authoritative host and publish it there.',
          { name });
      },
    });

    // --- Sharing (§20.3, "Sharing a form") --------------------------------

    // Share, as a file: a read like every other, open, recording nothing.
    app.get<{ Params: { name: string } }>(`${WORKSPACE_PATH}/share/:name`, async (request, reply) => {
      const { name } = request.params;
      const form = await getForm(db, name);
      // A dark form is not shared any more than it is served: its name may never have been public.
      const q = form ? await qualifies(db, config, name, form.kind) : null;
      if (!form || !q?.ok) return refusal(reply, 404, 'workspace.not-found', `This host holds no form for "${name}" that it will share.`);
      const here = hostOrigin(request);
      const carrier = buildCarrier({
        at: new Date(),
        from: form.kind === 'shared' ? form.origin : here,
        via: form.kind === 'shared' ? [...form.via, here] : [],
        operator: deps.operator ?? null,
        items: [{ name, etag: formETag(form), updated_at: form.updated_at, document: presentForm(form).document }],
      });
      return reply
        .header('cache-control', 'no-store')
        .header('x-cp-surface', 'workspace')
        .header('content-disposition', `attachment; filename="${name}.cp.json"`)
        .type('application/json')
        .send(JSON.stringify(carrier, null, 2));
    });

    // Import: a carrier, a bare document, or a link — previewed unless told to apply.
    app.post(`${WORKSPACE_PATH}/import`, async (request, reply) => {
      const credential = authenticate(request, reply);
      if (!credential) return reply;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
      if (!isObject(body)) return refusal(reply, 400, 'workspace.not-a-carrier', 'Import takes a JSON object.');

      let set: IncomingSet;
      if (typeof body['link'] === 'string') {
        const target = parseLink(body['link'], { allowHttp: deps.allowHttpLinks === true });
        if ('refused' in target) return refusal(reply, 400, `workspace.${target.refused}`, target.detail);
        let answered;
        try {
          answered = await linkFetch(target.url);
        } catch (error) {
          return refusal(reply, 502, 'workspace.link-unreachable',
            `This host could not fetch ${target.url.origin}: ${(error as Error).message}. Nothing was imported. If the two hosts cannot reach each other, ask for the file instead — Share offers both.`);
        }
        const incoming = incomingFromLink(target, answered);
        if ('refused' in incoming) return refusal(reply, 422, `workspace.${incoming.refused}`, incoming.detail);
        set = incoming;
      } else {
        const parsed = parseIncoming(isObject(body['source']) ? body['source'] : body);
        if ('refused' in parsed) return refusal(reply, 400, `workspace.${parsed.refused}`, parsed.detail);
        set = parsed;
      }

      const apply = body['apply'] === true || (request.query as Record<string, unknown>)['apply'] === 'true';
      const replace: Record<string, string> = {};
      if (isObject(body['replace'])) {
        for (const [k, v] of Object.entries(body['replace'])) if (typeof v === 'string') replace[k] = v;
      }
      const items: ImportRow[] = await importSet(db, config, set, {
        apply,
        replace,
        by: signature(credential),
        ...(deps.catchUp ? { catchUp: deps.catchUp } : {}),
      });
      reply.header('cache-control', 'no-store').header('x-cp-surface', 'workspace');
      return reply.code(200).send({
        apply,
        origin: { from: set.origin, verified: set.verified, via: set.via, ...(set.link ? { link: set.link } : {}) },
        items,
        applied: items.filter((i) => i.applied).length,
        note: apply
          ? 'Imported items are held here as the rows say: own work saved, or shared copies kept as received. None is a version (§20.3).'
          : 'A preview: nothing has been written. Send the same with "apply": true — and, for each item that differs, its "current" ETag in "replace" — to import.',
      });
    });

    app.get(WORKSPACE_PATH, async (request, reply) => {
      const representation = negotiate(request.headers.accept, 'spec2026');
      // Dark forms are shown only to a request carrying the workspace
      // credential (§20.3). A dark form's name may never have been public —
      // nothing under `test` is registered anywhere — and an open page is the
      // wrong place to disclose one. The operator, who decides what to remove,
      // is exactly the party holding that credential.
      const operator = mayWriteWorkspace(credentials, request.headers.authorization) !== null;
      const dark: DarkForm[] = operator ? await darkForms(db, config) : [];
      const forms = (await listForms(db, config)).filter((f) => f.qualification.ok);
      const entries = [];
      for (const form of forms) {
        const q = form.qualification as Extract<Qualification, { ok: true }>;
        const moved = q.kind === 'held' ? await movedOnSince(db, form) : null;
        entries.push({
          name: form.name,
          href: `/${form.name}:unpublished`,
          held_as: q.kind === 'held' ? q.org.name : q.kind === 'shared' ? 'shared copy' : 'test',
          content_hash: form.content_hash,
          updated_at: form.updated_at,
          updated_by: form.updated_by,
          share: `/workspace/share/${form.name}`,
          ...(moved ? { published: moved } : {}),
          ...(form.kind === 'shared'
            ? {
                shared: {
                  holder: q.kind === 'shared' ? (q.holder?.name ?? null) : null,
                  from: form.origin,
                  verified: form.origin_verified === true,
                  via: form.via,
                  link: form.source_link,
                  at: form.shared_at,
                },
              }
            : {}),
        });
      }
      reply.header('cache-control', 'no-store').header('vary', 'Accept').header('x-cp-surface', 'workspace');
      const body = {
        surface: 'workspace',
        orgs: await holders(db, config),
        test: config.test,
        forms: entries,
        ...(config.test
          ? {
              test_names: (await testRegistrations(db)).map((t) => ({
                name: t.name,
                href: `/${t.name}`,
                registered_at: t.registered_at,
                registered_by: t.registered_by,
                saved: t.saved,
              })),
            }
          : {}),
        ...(operator ? { dark } : {}),
        note:
          'The unpublished forms held in the workspace on this host, as their authors saved them (§20.3). None is a version: the Registry holds no unpublished content (spec §7.3), and nothing here is in the distribution feed.',
      };
      if (representation === 'html' && renderHtml) return reply.type(MEDIA.html).send(renderIndex(body));
      return reply.type(MEDIA.spec2026).send(body);
    });
  }

  return { hooks, register };
}

// --- HTML ------------------------------------------------------------------

function whereHeld(q: Qualification): string {
  if (q.ok && q.kind === 'held') return `held by <strong>${escape(q.org.name)}</strong> in its workspace on this host`;
  if (q.ok && q.kind === 'shared') {
    return q.holder
      ? `kept on this host as a <strong>shared copy</strong> of a form whose name <strong>${escape(q.holder.name)}</strong> holds`
      : 'kept on this host as a <strong>shared copy</strong> of a <code>test</code> form — local exercise, never globally resolvable (spec §7.1)';
  }
  return 'held in the workspace on this host under the <code>test</code> Prefix — for local exercise, never globally resolvable (spec §7.1)';
}

function renderForm(
  form: WorkspaceForm,
  document: Record<string, unknown>,
  q: Qualification,
  versions: VersionSummary[],
  note: string | null,
  options: { bare?: boolean; link?: string } = {},
): string {
  const bare = options.bare === true;
  const cited = bare ? `cp:${form.name}` : `cp:${form.name}:unpublished`;
  const saved = `${escape(form.updated_at.toISOString().replace('T', ' ').slice(0, 16))} UTC by ${escape(form.updated_by)}`;
  const standing =
    note === null || note === 'test' || note === 'shared'
      ? ''
      : note.startsWith('same')
        ? `<p>Its contract fields are the same as ${escape(note.slice('same as '.length))}'s: nothing has changed since that publication.</p>`
        : `<p>It has moved on since ${escape(note.slice('moved on since '.length))}: what is here is not what is published.</p>`;

  const raw = bare
    ? `<div class="raw"><strong>The working document is the answer, not this page.</strong>
       <code>GET /${escape(form.name)}</code>
       with <code>Accept: application/cp+json; profile=2026</code>.
       ETag <code>${escape(form.content_hash)}</code>. It is served <code>no-store</code> and changes with every save:
       a test name never has a version, and this host is the only place it resolves (spec §7.1).</div>`
    : `<div class="raw"><strong>The form is the document, not this page.</strong>
       <code>GET /${escape(form.name)}:unpublished</code>
       with <code>Accept: application/cp+json; profile=2026</code>.
       ETag <code>${escape(form.content_hash)}</code>. It is served <code>no-store</code> and is never selected by
       <code>cp:${escape(form.name)}</code>: only a published version is (spec §8.6).</div>`;

  return page(
    bare ? form.name : `${form.name}:unpublished`,
    `<h1><code>${escape(cited)}</code></h1>
     <p>Status: <strong>Unpublished</strong></p>
     ${versionStrip(form.name, versions, 'unpublished', { href: bare ? `/${form.name}` : `/${form.name}:unpublished`, note })}
     ${form.kind === 'shared' ? sharedCallout(form, q) : `<div class="callout unpublished"><strong>This is the working copy, not a contract.</strong>
       It is ${whereHeld(q)} — not by the Registry, which never holds unpublished content (spec §7.3).
       It may change at any time, and a Connection bound against it is provisional (spec §6.3).
       Last saved ${saved}.</div>`}
     ${options.link ? shareBlock(form.name, options.link) : ''}
     ${standing}
     ${documentSections(document as Parameters<typeof documentSections>[0])}
     ${raw}`,
  );
}

const SHARE_STYLE = `<style>
  details.share,details.import{margin:12px 0;border:1px solid var(--line,#ddd);border-radius:8px;padding:8px 12px}
  details.share summary,details.import summary{cursor:pointer;font-weight:600}
  details.share input,details.import input[type=text],details.import input[type=password]{width:100%;font-family:monospace;padding:6px;margin:4px 0}
  .pill.import{cursor:pointer}
  details.import table td,details.import table th{padding:4px 8px;vertical-align:top}
  .verified{color:#1b7f3a}.stated{color:#9a6700}
</style>`;

/** Share, without a script: the link to select and copy, and the file to download (§20.3, "Sharing a form"). */
function shareBlock(name: string, link: string): string {
  return `${SHARE_STYLE}<details class="share"><summary>Share</summary>
    <p><strong>Link.</strong> Works for whoever can reach this host; it always gives the form as last saved here.
      <input type="text" readonly value="${escape(link)}" aria-label="Share link"></p>
    <p><strong>File.</strong> <a href="/workspace/share/${escape(name)}" download="${escape(name)}.cp.json">Download ${escape(name)}.cp.json</a>
      — a snapshot, for a partner who cannot reach this host. They take either in with <em>Import</em> on their own workspace.</p>
  </details>`;
}

/** The banner a shared copy wears instead of the author's (§20.3). */
function sharedCallout(form: WorkspaceForm, q: Qualification): string {
  const when = form.shared_at ? escape(form.shared_at.toISOString().slice(0, 10)) : 'an earlier date';
  const from = form.origin ? `<code>${escape(form.origin)}</code>` : 'a host it did not name (it arrived as a bare document)';
  const via = form.via.length > 0 ? ` by way of ${form.via.map((v) => `<code>${escape(v)}</code>`).join(', ')}` : '';
  const proof = form.origin_verified
    ? '<span class="verified">Origin verified</span>: this host fetched it from there over TLS.'
    : '<span class="stated">Origin as stated</span>: it came in a file, so where it came from is the file\'s claim, not something this host checked.';
  const update = form.source_link
    ? ` <a href="/workspace?import=${encodeURIComponent(form.source_link)}#import">Check for update</a> — the same link, previewed before anything changes.`
    : '';
  return `<div class="callout unpublished"><strong>A copy of the author's working form, shared from ${from}${via} on ${when}.</strong>
     It is ${whereHeld(q)}. The author's current form may differ, and a Connection bound against it is provisional (spec §6.3).
     It is never edited here: a newer import replaces it. ${proof}${update}
     ETag <code>${escape(form.content_hash)}</code>.</div>`;
}

function renderTestUnsaved(name: string, registeredAt: Date): string {
  return page(
    name,
    `<h1><code>cp:${escape(name)}</code></h1>
     <p>Status: <strong>Unpublished</strong> · registered on this host ${escape(registeredAt.toISOString().slice(0, 10))}</p>
     <div class="callout unpublished"><strong>Registered here; nothing saved yet.</strong>
       ${whereHeld({ ok: true, kind: 'test' })}. Save the working document with
       <code>PUT /${escape(name)}:unpublished</code> and the workspace credential, and this name resolves to it.</div>`,
  );
}

function renderIndex(body: {
  orgs: { id: string; name: string | null }[];
  test: boolean;
  forms: {
    name: string;
    href: string;
    held_as: string;
    share: string;
    updated_at: Date;
    updated_by: string;
    published?: { version: number; same: boolean };
    shared?: { holder: string | null; from: string | null; verified: boolean; link: string | null };
  }[];
}): string {
  const rows = body.forms
    .map((f) => {
      const standing = f.shared
        ? `from ${f.shared.from ? `<code>${escape(f.shared.from)}</code>` : '<em>unknown origin</em>'} · ${f.shared.verified ? '<span class="verified">verified</span>' : '<span class="stated">as stated</span>'}${
            f.shared.link ? ` · <a href="/workspace?import=${encodeURIComponent(f.shared.link)}#import">check for update</a>` : ''
          }`
        : f.published
          ? f.published.same ? `same as v${f.published.version}` : `moved on since v${f.published.version}`
          : '<em>none published</em>';
      const heldAs = f.shared ? `shared copy${f.shared.holder ? ` · ${escape(f.shared.holder)}` : ' · test'}` : escape(f.held_as);
      return `<tr><td><a href="${escape(f.href)}"><code>${escape(f.name)}</code></a></td>
         <td>${heldAs}</td>
         <td>${standing}</td>
         <td>${escape(f.updated_at.toISOString().slice(0, 10))}</td>
         <td>${escape(f.updated_by)}</td>
         <td><a href="${escape(f.href)}">link</a> · <a href="${escape(f.share)}" download="${escape(f.name)}.cp.json">file</a></td></tr>`;
    })
    .join('');
  const serves = body.orgs.map((o) => `<strong>${escape(o.name ?? o.id)}</strong>`).join(', ');

  return page(
    'Workspace — unpublished forms on this host',
    `${SHARE_STYLE}<h1>Workspace</h1>
     <p class="versions"><a class="pill import" href="#import" onclick="document.getElementById('import').open=true">Import</a></p>
     ${importPanel()}
     <p class="section-intro">The unpublished forms held on this host — the working copies
       behind the names ${serves || 'no organization'} holds${body.test ? ', <code>test.*</code> forms for local exercise' : ''},
       and copies others have shared here. None is a version, and nothing here is in the distribution feed (§20.3).</p>
     ${body.forms.length === 0 ? '<p>No forms are held here yet.</p>' : `<div class="card"><table>
       <tr><th>Name</th><th>Held as</th><th>Standing</th><th>Saved</th><th>By</th><th>Share</th></tr>${rows}</table></div>`}
     <p class="raw">A form is saved with <code>PUT /&lt;name&gt;:unpublished</code> under the workspace credential and read
       by anyone with <code>GET</code>. Share gives its link, or a file to send; Import takes either in from a partner.
       The Registry surface on this host answers every other URL exactly as the authoritative host does.</p>`,
    'workspace',
  );
}

/**
 * The Import panel (§20.3, "Sharing a form"): paste a link or choose a file,
 * preview, import. The one script on any page this design renders — it has
 * to be, because the workspace credential travels as a bearer token and an
 * instance keeps no session. The token stays in this page's memory: it is
 * read from the field for each request and never stored.
 */
function importPanel(): string {
  return `<details class="import" id="import"><summary>Import a shared Profile</summary>
    <form action="/workspace/import" method="post" onsubmit="return false">
      <p><label>Paste a Share link<br><input type="text" name="link" placeholder="https://host/name:unpublished  or  https://host/test.name" autocomplete="off"></label></p>
      <p><label>…or choose a file someone sent you (<code>.cp.json</code>, or a Profile document)<br><input type="file" name="file" accept=".json,application/json"></label></p>
      <p><label>This host's workspace credential<br><input type="password" name="token" autocomplete="off"></label></p>
      <p><button type="button" data-act="preview">Preview</button> <button type="button" data-act="apply" disabled>Import</button></p>
      <div class="result" aria-live="polite"></div>
    </form>
  </details>
  <script>${IMPORT_SCRIPT}</script>`;
}

const IMPORT_SCRIPT = `(function () {
  var panel = document.getElementById('import');
  if (!panel) return;
  var form = panel.querySelector('form');
  var out = panel.querySelector('.result');
  var applyButton = form.querySelector('[data-act=apply]');
  var lastSource = null;
  var params = new URLSearchParams(location.search);
  if (params.get('import')) { panel.open = true; form.link.value = params.get('import'); }
  if (location.hash === '#import') panel.open = true;

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function say(message, cls) { out.replaceChildren(el('p', message, cls)); }

  async function source() {
    var link = form.link.value.trim();
    if (link) return { link: link };
    var file = form.file.files[0];
    if (!file) throw new Error('Paste a link or choose a file.');
    var text = await file.text();
    try { return { source: JSON.parse(text) }; } catch (e) { throw new Error('That file is not JSON, so it is not a carrier or a Profile document.'); }
  }

  async function send(body) {
    var token = form.token.value.trim();
    if (!token) throw new Error('Enter the workspace credential of this host: importing writes to the workspace.');
    var r = await fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    var j = null;
    try { j = await r.json(); } catch (e) { j = { message: 'The host did not answer with JSON (' + r.status + ').' }; }
    if (r.status !== 200) throw new Error(j.message || ('Refused: ' + r.status));
    return j;
  }

  function render(result) {
    var o = result.origin || {};
    var lead = el('p');
    lead.textContent = (result.apply ? 'Imported ' + result.applied + ' of ' + result.items.length + '. ' : 'Preview — nothing written yet. ') +
      'From ' + (o.from || 'an unknown origin') + (o.via && o.via.length ? ' by way of ' + o.via.join(', ') : '') +
      (o.verified ? ' (verified: fetched over TLS).' : ' (as stated).');
    var table = el('table');
    var head = el('tr');
    ['Name', 'Lands as', 'Outcome', 'Replace?', 'Detail'].forEach(function (h) { head.appendChild(el('th', h)); });
    table.appendChild(head);
    var differs = 0;
    result.items.forEach(function (i) {
      var tr = el('tr');
      tr.appendChild(el('td', i.name));
      tr.appendChild(el('td', i.as ? (i.as === 'own' ? 'own work' : 'shared copy') + (i.holder ? ' · ' + i.holder : '') : ''));
      tr.appendChild(el('td', i.applied ? (i.outcome === 'new' ? 'imported' : 'replaced') : (i.refusal ? 'refused: ' + i.refusal : i.outcome)));
      var cell = el('td');
      if (!result.apply && i.outcome === 'differs' && i.current) {
        var box = el('input'); box.type = 'checkbox'; box.dataset.name = i.name; box.dataset.current = i.current; cell.appendChild(box); differs++;
      }
      tr.appendChild(cell);
      tr.appendChild(el('td', i.detail || ''));
      table.appendChild(tr);
    });
    out.replaceChildren(lead, table);
    if (!result.apply) {
      var importable = result.items.some(function (i) { return i.outcome === 'new' || i.outcome === 'differs'; });
      applyButton.disabled = !importable;
      if (differs) out.appendChild(el('p', 'Tick Replace for a form held here that should give way to the imported one.'));
    } else {
      applyButton.disabled = true;
      var again = el('p'); var a = el('a', 'Reload the workspace'); a.href = location.pathname; again.appendChild(a); out.appendChild(again);
    }
  }

  form.querySelector('[data-act=preview]').addEventListener('click', async function () {
    applyButton.disabled = true;
    try { lastSource = await source(); say('Previewing…'); render(await send(lastSource)); }
    catch (e) { say(e.message, 'stated'); }
  });
  applyButton.addEventListener('click', async function () {
    if (!lastSource) return;
    var replace = {};
    out.querySelectorAll('input[type=checkbox]:checked').forEach(function (b) { replace[b.dataset.name] = b.dataset.current; });
    var body = Object.assign({}, lastSource, { apply: true, replace: replace });
    try { render(await send(body)); } catch (e) { say(e.message, 'stated'); }
  });
})();`;
