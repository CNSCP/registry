/**
 * The workspace surface — design §20.3.
 *
 *   GET    /<name>:unpublished   the form, as the author's answer (open, like resolution)
 *   PUT    /<name>:unpublished   save the form               (the workspace credential; If-Match)
 *   DELETE /<name>:unpublished   remove the form             (the workspace credential)
 *   GET    /workspace            every form this host holds  (open)
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
import { instanceRefusal } from '../distribution/routes.ts';
import type { WriteHandler } from '../distribution/forward.ts';
import { mayWriteWorkspace, signature, type WorkspaceCredential } from './credential.ts';
import {
  formETag,
  getForm,
  heldForms,
  holders,
  listForms,
  movedOnSince,
  presentForm,
  qualifies,
  removeForm,
  saveForm,
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
  const status = q.reason === 'malformed' ? 400 : q.reason === 'not-registered' ? 404 : 403;
  return refusal(reply, status, `workspace.${q.reason}`, q.detail);
}

/** The pill's note: where the form stands against what is published (§20.3). */
async function noteFor(db: Queryable, form: WorkspaceForm, q: Qualification): Promise<string | null> {
  if (q.ok && q.kind === 'test') return 'test';
  const moved = await movedOnSince(db, form);
  if (!moved) return null;
  return moved.same ? `same as v${moved.version}` : `moved on since v${moved.version}`;
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  const { db, config, credentials, upstream } = deps;
  const renderHtml = deps.html ?? true;
  const onRegistryWrite: WriteHandler = deps.onRegistryWrite ?? (async (_request, reply) => instanceRefusal(reply, upstream));

  function mark(reply: FastifyReply, form: WorkspaceForm): void {
    reply
      .header('cache-control', 'no-store')
      .header('vary', 'Accept')
      .header('etag', formETag(form))
      .header('x-cp-surface', 'workspace')
      .header('x-cp-status', 'unpublished');
  }

  const hooks: WorkspaceHooks = {
    async unpublished(name, representation, reply) {
      const q = await qualifies(db, config, name);
      if (!q.ok) return false;
      const form = await getForm(db, name);
      if (!form) return false;

      mark(reply, form);
      if (etagMatches(reply.request.headers['if-none-match'], formETag(form))) {
        reply.code(304).send();
        return true;
      }

      const presented = presentForm(form);
      if (representation === 'html' && renderHtml) {
        const registered = await resolveName(db, name);
        const note = await noteFor(db, form, q);
        reply.type(MEDIA.html).send(renderForm(form, presented.document, q, registered?.versions ?? [], note));
        return true;
      }
      reply.type(MEDIA.spec2026).send(presented.text);
      return true;
    },

    async held(names) {
      const out = new Map<string, UnpublishedPill>();
      for (const name of await heldForms(db, names)) {
        const q = await qualifies(db, config, name);
        if (!q.ok) continue; // dark: released or transferred away, swept on the next sync
        const form = await getForm(db, name);
        if (!form) continue;
        out.set(name, { href: `/${name}:unpublished`, note: await noteFor(db, form, q) });
      }
      return out;
    },

    async summary() {
      const forms = await listForms(db, config);
      return {
        orgs: await holders(db, config),
        test: config.test,
        forms: forms.filter((f) => f.qualification.ok).length,
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

    app.put<{ Params: { ref: string } }>('/:ref', async (request, reply) => {
      const { name, version } = splitReference(request.params.ref);
      if (version !== 'unpublished') return onRegistryWrite(request, reply);

      const credential = authenticate(request, reply);
      if (!credential) return reply;

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

    app.get(WORKSPACE_PATH, async (request, reply) => {
      const representation = negotiate(request.headers.accept, 'spec2026');
      const forms = (await listForms(db, config)).filter((f) => f.qualification.ok);
      const entries = [];
      for (const form of forms) {
        const q = form.qualification as Extract<Qualification, { ok: true }>;
        const moved = q.kind === 'held' ? await movedOnSince(db, form) : null;
        entries.push({
          name: form.name,
          href: `/${form.name}:unpublished`,
          held_as: q.kind === 'held' ? q.org.name : 'test',
          content_hash: form.content_hash,
          updated_at: form.updated_at,
          updated_by: form.updated_by,
          ...(moved ? { published: moved } : {}),
        });
      }
      reply.header('cache-control', 'no-store').header('vary', 'Accept').header('x-cp-surface', 'workspace');
      const body = {
        surface: 'workspace',
        orgs: await holders(db, config),
        test: config.test,
        forms: entries,
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
  return 'held in the workspace on this host under the <code>test</code> Prefix — for local exercise, never globally resolvable (spec §7.1)';
}

function renderForm(
  form: WorkspaceForm,
  document: Record<string, unknown>,
  q: Qualification,
  versions: VersionSummary[],
  note: string | null,
): string {
  const saved = `${escape(form.updated_at.toISOString().replace('T', ' ').slice(0, 16))} UTC by ${escape(form.updated_by)}`;
  const standing =
    note === null || note === 'test'
      ? ''
      : note.startsWith('same')
        ? `<p>Its contract fields are the same as ${escape(note.slice('same as '.length))}'s: nothing has changed since that publication.</p>`
        : `<p>It has moved on since ${escape(note.slice('moved on since '.length))}: what is here is not what is published.</p>`;

  return page(
    `${form.name}:unpublished`,
    `<h1><code>cp:${escape(form.name)}:unpublished</code></h1>
     <p>Status: <strong>Unpublished</strong></p>
     ${versionStrip(form.name, versions, 'unpublished', { href: `/${form.name}:unpublished`, note })}
     <div class="callout unpublished"><strong>This is the working copy, not a contract.</strong>
       It is ${whereHeld(q)} — not by the Registry, which never holds unpublished content (spec §7.3).
       It may change at any time, and a Connection bound against it is provisional (spec §6.3).
       Last saved ${saved}.</div>
     ${standing}
     ${documentSections(document as Parameters<typeof documentSections>[0])}
     <div class="raw"><strong>The form is the document, not this page.</strong>
       <code>GET /${escape(form.name)}:unpublished</code>
       with <code>Accept: application/cp+json; profile=2026</code>.
       ETag <code>${escape(form.content_hash)}</code>. It is served <code>no-store</code> and is never selected by
       <code>cp:${escape(form.name)}</code>: only a published version is (spec §8.6).</div>`,
  );
}

function renderIndex(body: {
  orgs: { id: string; name: string | null }[];
  test: boolean;
  forms: { name: string; href: string; held_as: string; updated_at: Date; updated_by: string; published?: { version: number; same: boolean } }[];
}): string {
  const rows = body.forms
    .map(
      (f) =>
        `<tr><td><a href="${escape(f.href)}"><code>${escape(f.name)}</code></a></td>
         <td>${escape(f.held_as)}</td>
         <td>${f.published ? (f.published.same ? `same as v${f.published.version}` : `moved on since v${f.published.version}`) : '<em>none published</em>'}</td>
         <td>${escape(f.updated_at.toISOString().slice(0, 10))}</td>
         <td>${escape(f.updated_by)}</td></tr>`,
    )
    .join('');
  const serves = body.orgs.map((o) => `<strong>${escape(o.name ?? o.id)}</strong>`).join(', ');

  return page(
    'Workspace — unpublished forms on this host',
    `<h1>Workspace</h1>
     <p class="section-intro">The unpublished forms held on this host, as their authors saved them — the working copies
       behind the names ${serves || 'no organization'} holds${body.test ? ', and <code>test.*</code> forms for local exercise' : ''}.
       None is a version, and nothing here is in the distribution feed (§20.3).</p>
     ${body.forms.length === 0 ? '<p>No forms are held here yet.</p>' : `<div class="card"><table>
       <tr><th>Name</th><th>Held as</th><th>Against published</th><th>Saved</th><th>By</th></tr>${rows}</table></div>`}
     <p class="raw">A form is saved with <code>PUT /&lt;name&gt;:unpublished</code> under the workspace credential and read
       by anyone with <code>GET</code>; the Registry surface on this host answers every other URL exactly as
       the authoritative host does.</p>`,
    'workspace',
  );
}
