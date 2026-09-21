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
Forwarding (one URL for your tools, with your own canon token relayed as a pipe) and the
private/public worked deployments follow in the next release.

## Deprecation and stewardship reach you through the journal

A version's Properties never change, so a Governor may cache `GET /<name>:<n>` forever
(§18). Deprecation and Owner/Website changes are journal entries; the instance applies them
on its next sync, and the selection surface `GET /<name>` — what Match reads — reflects them
from then on. Set `SYNC_INTERVAL_SECONDS` to the staleness your Realm can accept.
