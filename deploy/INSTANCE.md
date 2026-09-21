# Running a local Registry instance

Spec §7.4: "a conforming Governor SHALL be able to operate from a local Registry
instance." This is how. An instance is the resolution server plus a follower
(design §20): it takes the authoritative host's snapshot, follows its journal,
verifies everything it takes in, and serves the same resolution API from its own
database — byte-identical. It accepts no writes; `cp.cnscp.io` is the only place
a Profile is registered or published.

## What you need

- Node 22+, a PostgreSQL (16 recommended) of your own, and this repository or its image.
- Outbound HTTPS to the authoritative host. Nothing inbound is required by the Registry;
  your Governors reach the instance on whatever host name you give it (`cp.<your-org>` is
  the convention, §4.4).

## Start

```sh
createdb cp_instance
export DATABASE_URL=postgres://.../cp_instance
export UPSTREAM_URL=https://cp.cnscp.io
export RESOLUTION_PORT=8080          # default
export SYNC_INTERVAL_SECONDS=60      # default; 0 = sync once at start

npm run migrate up                   # the same schema; the instance uses the public tables
npm run instance
```

On an empty database the instance fetches `GET /distribution/snapshot`, lays it down in
one transaction, and records the snapshot's chain head as its cursor. On every start, and
every `SYNC_INTERVAL_SECONDS` after, it fetches `GET /distribution/journal?since=<cursor>`
and, page by page, checks that the first entry continues from the link it holds, recomputes
every public event's hash, checks every published document against the content hash its
act recorded, applies the acts, keeps a verbatim copy of the entries, and advances the
cursor — one transaction per page. A page that fails leaves the instance exactly where it
was, with the reason on `/distribution/status`.

The container image serves the same purpose with `node --experimental-strip-types
src/instance-server.ts` as the command and the variables above.

## Check it

```sh
curl -s http://127.0.0.1:8080/distribution/status
# { role: "instance", upstream, cursor: { seq, event_hash }, behind: 0, lag_seconds, last_error: null, ... }

curl -sI -H 'Accept: application/cp+json; profile=2026' http://127.0.0.1:8080/padi.lighting:2 | grep -i content-digest
curl -sI -H 'Accept: application/cp+json; profile=2026' https://cp.cnscp.io/padi.lighting:2      | grep -i content-digest
# identical

npm run verify-journal -- http://127.0.0.1:8080 --resolve
npm run verify-journal -- https://cp.cnscp.io --resolve
```

`verify-journal` needs no instance and no credential; anyone may run it against anyone's
host. Against an instance it starts from the instance's bootstrap point (the instance
answers `416` with `earliest_seq` for anything earlier) and checks the links from there.

## What an instance does and does not do

- Serves every `GET` of the resolution profile (§19): versions (immutable), the selection
  surface (revalidated), registrations, allocation pages, the catalog, the HTML pages, and
  `/distribution/*` from its own verified copy — so a second instance may follow the first.
- Answers `405` with `{ authoritative: "https://cp.cnscp.io" }` to every `PUT`, `POST`,
  `PATCH` and `DELETE` on a Registry path. No authoring route exists on an instance to find.
  The one write surface it may carry is the workspace's `PUT`/`DELETE /<name>:unpublished`
  (below), which is not a Registry surface.
- Writes no audit events. Its `audit_event` table stays empty; the journal copy is in
  `journal_entry`, and its position in `instance_state`.
- Does not yet verify a signed anchor of the chain head: `anchor_verified: null`. Until the
  operator publishes one (design §25 Q12), an instance can detect a tampered or broken
  chain but not a fork served only to it.

## A workspace beside the instance (design §20.3)

An instance may hold your organization's **unpublished forms** next to its mirror — the
working copies behind the names you hold, and `test.*` forms for local exercise (spec §7.1).
Anyone who can reach the host reads them at `GET /<name>:unpublished`; you save them with
the workspace credential. Nothing about the Registry surface changes: `/<name>` and
`/<name>:<n>` still answer byte-for-byte as `cp.cnscp.io` does, and nothing you save ever
enters the distribution feed.

```sh
npm run migrate:workspace up          # the workspace's own table, in its own migration set
export WORKSPACE_ORGS=<organization id>   # see below; comma-separate several
export WORKSPACE_TEST=true                # admit test.* forms — set this on a PRIVATE host; leave it off in public
export CP_WORKSPACE_TOKEN=$(openssl rand -base64 36)   # 32+ characters; or CP_WORKSPACE_TOKENS=anto=…,assistant=…
export CP_WORKSPACE_PRINCIPAL=you@example.com
npm run instance
```

The organization id is in the snapshot (the allocation page shows the holder's name, not its id):

```sh
curl -s https://cp.cnscp.io/distribution/snapshot | jq -r '.allocations[] | select(.tlp=="padi") | .org_id'
```

Then, with the document in the 2026 shape:

```sh
curl -X PUT http://127.0.0.1:8080/acme.meter.flow:unpublished \
     -H "Authorization: Bearer $CP_WORKSPACE_TOKEN" -H 'Content-Type: application/json' \
     --data @acme.meter.flow.json
curl http://127.0.0.1:8080/acme.meter.flow:unpublished          # anyone; Status: Unpublished, no Version
curl http://127.0.0.1:8080/workspace                             # every form this host holds
```

The rules, briefly: a form is held only for a name registered under a Prefix one of your
organizations holds, or under `test.*` where admitted — nothing else, so this host can never
hold another organization's drafts. `Header.Name` must equal the name. A save over an
existing form carries `If-Match` with the ETag you read (`412` if it moved, `428` if the
header is missing), so co-authors never overwrite each other unseen. Every answer from the
workspace is marked `x-cp-surface: workspace`, `x-cp-status: unpublished`, `no-store`, with no
`Content-Digest`: it is never a version, is never selected by the bare name, and is never
served in the legacy shape. The host holds **no canon credential** — publishing is still your
own act at `cp.cnscp.io`, carrying the content, exactly as before; after it, the form persists
and the page says whether it has moved on since.

A released or transferred name's form goes dark at once and is swept after the next sync.
With none of the `WORKSPACE_*` / `CP_WORKSPACE_*` variables set, none of this is mounted.

A name you registered a moment ago is not in this mirror until the next sync. The workspace
catches up for itself before refusing a save as `not-registered`, so register-then-save works
straight away; it does not do this for any other refusal, because no other one here can be
invented by a stale mirror.

## Forwarding: one URL for your tools (design §20.3)

By default a write to a Registry path gets `405` and the authoritative host's URL — your tools
talk to `cp.cnscp.io` for acts and to this host for drafts. With `FORWARD_WRITES=true` this host
relays those writes instead, carrying **your own credential**, and hands back the authoritative
host's answer verbatim with `x-cp-forwarded-to` on it. Then one URL does everything.

```sh
export FORWARD_WRITES=true
npm run instance
# register at canon, through this host, with YOUR canon token:
curl -i -X PUT http://127.0.0.1:8080/acme.meter.flow -H "Authorization: Bearer $CP_REGISTRY_TOKEN"
```

What it is, exactly: a pipe. This host holds no credential for the authoritative store, so it
can act for nobody; it refuses nothing of its own, so it can never block an act canon would
accept; it logs and keeps nothing it relays; and you can always make the same call at
`cp.cnscp.io` and compare. Only Profile paths are relayed — `/operator/*`, `/auth/*`, `/account`
and every other dotless path still get the `405` — and `:unpublished` never goes anywhere,
because it is this host's own. If the authoritative host cannot be reached you get a `502`
naming it, which says plainly that nothing here refused your act and nothing here recorded it;
for an irreversible act, check at canon whether it took effect before retrying.

Inside a security boundary this is usually what you want: the instance becomes the one thing
that talks out, and every tool inside points at it.

## The assistant's tools (MCP)

`npm run mcp` gains two tools for the workspace, and they are the only ones that carry the
workspace credential:

```jsonc
{
  "CP_REGISTRY_URL":    "https://cp.cnscp.io",   // or this host, when it forwards
  "CP_REGISTRY_TOKEN":  "…",                     // your canon token: acts
  "CP_WORKSPACE_URL":   "http://127.0.0.1:8080", // omit when CP_REGISTRY_URL forwards
  "CP_WORKSPACE_TOKEN": "…"                      // this host's workspace credential: drafts
}
```

`get_unpublished` reads a form (no credential needed) and hands back its ETag; `save_unpublished`
writes one and wants that ETag as `if_match` over an existing form. `register_name` takes an
optional document and makes the two calls in order — the act at canon, then the save here —
reporting each separately. No tool combines them into one act, and no server ever will.

## Two worked deployments

**Private — inside your own network, for research, development and testing.** `test.*` forms
are admitted here (spec §7.1: local exercise, never globally resolvable), so an implementer can
exercise a Profile before holding a Prefix, or before the name itself should be public.

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: cp, POSTGRES_DB: cp }
    volumes: [ "cpdata:/var/lib/postgresql/data" ]
  registry:
    image: ghcr.io/cnscp/registry:latest
    depends_on: [ db ]
    environment:
      DATABASE_URL: postgres://postgres:cp@db:5432/cp
      UPSTREAM_URL: https://cp.cnscp.io
      SYNC_INTERVAL_SECONDS: "60"
      WORKSPACE_ORGS: "<your organization id>"
      WORKSPACE_TEST: "true"          # private host: admit test.* forms
      FORWARD_WRITES: "true"          # one URL for everything inside the boundary
      CP_WORKSPACE_PRINCIPAL: you@example.com
      CP_WORKSPACE_TOKENS: "you=<32+ chars>,assistant=<32+ chars>"
    command: sh -c "npm run migrate up && npm run migrate:workspace up && npm run instance"
    ports: [ "8080:8080" ]
volumes: { cpdata: {} }
```

The only outbound path it needs is to `cp.cnscp.io`; nothing needs an inbound one. Two tokens
with two labels is worth doing from the start — it is what tells your saves from your
assistant's in `updated_by`.

**Public — conveyance, as `cp.padi.io` will be.** The same image with `WORKSPACE_TEST` left
off, because "never globally resolvable" is a statement about the Registry and a public host
serving `test.*` at a public URL should be a choice someone made. Reads are open, which is what
lets a testing partner exercise your Profile with no credential at all; writes take the
workspace credential, which you give to co-authors and to nobody else. Whether to forward on a
public host is a separate decision: it means your own canon token transits it.

Either posture can follow the other rather than canon — an instance serves the journal from its
own verified copy — which gives a boundary one egress point. Drafts do **not** replicate between
them: unpublished content is never in the feed, so a form reaches the public host only when its
author saves it there.

## Deprecation and stewardship reach you through the journal

A version's Properties never change, so a Governor may cache `GET /<name>:<n>` forever
(§18). Deprecation and Owner/Website changes are journal entries; the instance applies them
on its next sync, and the selection surface `GET /<name>` — what Match reads — reflects them
from then on. Set `SYNC_INTERVAL_SECONDS` to the staleness your Realm can accept.
