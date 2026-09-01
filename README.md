# Connection Profile Registry

Part One (the allocation spine) and the Profile serialization mappers.
Design: [`../REGISTRY-DESIGN.md`](../REGISTRY-DESIGN.md) v0.5.

**The normative anchor is the CNS/CP 2026 revision, which is still in draft.** It is pinned
by hash — `bbeec3f7…22be09b`, assembled 26 August 2026 — and `npm run verify-spec` checks
that the copy beside the design document is still that one. The public repository at
`github.com/CNSCP/specification` carries the **2022** draft, which this code does not
follow: different section numbering, different Status values, `"Source"` on each Property,
and no Propagate attribute. `spec2026.ts` refuses `"Status": "Active"` for that reason.

## What this is, and what it deliberately is not

Part One answers one question for the rest of the Registry:

> Does an authorization exist for this actor to register or publish this name, under an active allocation?

That is spec §7.3's requirement verbatim, and `authorizes()` in
[`src/part-one/authorizes.ts`](src/part-one/authorizes.ts) is it. Part Two calls that and
nothing else — one query in, events out (design §4.1).

Built here (the **spine**, design §10.3):

- The §6 ownership tables — organization, member, allocation, authorization_record
- `authorizes()`, the seam, pure over an injected store
- The §3.1 name and reference grammar
- The §3.2 reserved and withheld Prefix policy
- The §4.3 append-only hash-chained audit log
- The §10.2 bootstrap: eighteen grandfathered Prefixes, with rationale, audited

The Profile mappers ([`src/profile/`](src/profile/)) — what Part Two stores and Part Three
will serve:

- The canonical model — representation-agnostic, per §19.2
- Both serializations: the deployed key-presence shape and the 2026 spec shape
- §9.4 conformance checking, as a report rather than a gate
- The §10.4 import policy for the 70 deployed records

Part Three resolution ([`src/part-three/`](src/part-three/)) — §19, and the only part
other people deploy:

- Resolution at the root under the dot rule; `/profiles/` alias for legacy SDKs
- Content negotiation: 2026 shape by default, deployed shape on `application/json`,
  a non-summarizing HTML page for browsers
- **The §18 caching split** — a versioned fetch is `immutable`; the unversioned
  selection surface is always revalidated, because that is what Match reads
- Strong ETags and RFC 9530 `Content-Digest` from the stored content hash
- The §19.3 allocation page, and the 404-not-an-index rule for interior names

Part Two authoring ([`src/part-two/`](src/part-two/)) — §15, the Phase 0 publication path:

- The full lifecycle by HTTP method on the same paths resolution reads:
  `PUT /<name>` registers, `PUT /<name>:draft` shapes, `POST /<name>/publish` freezes,
  `POST :n/deprecate`, `PATCH :n/header` (Owner/Website only), `DELETE` discards unpublished
- **The additivity gate** (§23 priority 2): removal, redefinition, and mandatory additions
  refused with structured `{ code, gate, property, ... }` findings an agent can act on
- `?dry_run=true` runs every gate and provably writes nothing
- Credential scopes `draft:write · publish · deprecate · disclose` (§15.2) — a machine
  author holds `draft:write` alone: the whole of the work, none of the damage
- The disclosure trapdoor with its confirmation challenge: a non-operated Realm returns
  409 until the caller sends `confirm_public: true`, and the flip is irreversible

The MCP server ([`src/mcp/server.ts`](src/mcp/server.ts)) — §15.1's "worth building early",
since hand-authoring by an assistant is the Phase 0 publication path:

- Eleven tools over the authoring verbs, run with `npm run mcp` (stdio); configure with
  `CP_REGISTRY_URL` and `CP_REGISTRY_TOKEN` — the token's scopes decide what the tools may do
- Deliberately THIN: an HTTP client of the same API every other client uses (§4.4 — no
  privileged path), so every gate and audit write happens exactly once
- Registry refusals pass through verbatim as structured findings; the two irreversible acts
  say IRREVERSIBLE in their descriptions, and `authorize_realm` tells the assistant to never
  confirm public disclosure on its own judgment
- `npm run authoritative` starts the combined authoring+resolution host it talks to

Seam isolation (§23 priority 6, §4.1 rule 2): with Part One down, reads and edits keep
working — edits via a local fallback to the recorded registrant, which grants nothing while
the seam is healthy — and only registration and publication block, with a structured 503
that says what still works. An outage is never reported as a denial.

And Part Two's storage layer (§12), enough to hold what the import produces:

- `profile` and `profile_version`, with the Draft on the profile row and **no status column**
  — status belongs to a version (spec §6.4), and a name with no versions is a legitimate state
- **The narrow immutability trigger** (§23 priority 3) — content, hash, bytes and version
  frozen; `status` moves published → deprecated one way; `Owner` and `Website` stay mutable
  because spec §6.4 permits it and forbidding them is the opposite non-conformance
- Version assignment under a row lock — max+1, assigned by the Registry, never by the author
- The disclosure trapdoor as a database trigger: once public, no path walks it back

**Not built, and not stubbed** — Phase 2 (§25): applications, verification challenges,
renewal, redemption, transfers, disputes, and the whole §9.2 operator plane. A route that
returns 501 invites a client to be written against it, so those routes are absent instead.

One absence is permanent rather than pending. There is no endpoint anywhere to alter,
unpublish, or withhold a published version. Spec §9.3 forbids all three, so the capability
does not exist in the codebase — its absence is the enforcement.

## Running it

```sh
npm install
npm test                  # 332 tests: 183 unit + 149 against a real Postgres
npm run test:unit         # the pure logic, milliseconds
npm run test:integration  # migrations, triggers, constraints, the hash chain
npm run typecheck
npm run verify-spec       # is the normative anchor still the one we built against?

createdb cp_registry
cp .env.example .env          # set DATABASE_URL and INTERNAL_SEAM_TOKEN
npm run migrate up

npm run seed -- --dry-run     # print the bootstrap plan, write nothing
npm run seed                  # apply it, audited

npm run dev
```

**The unit tests need no database.** `authorizes()` takes an injected `OwnershipStore`, and
[`memory-store.ts`](src/part-one/memory-store.ts) is a second real implementation of that
interface rather than a mock — so the whole ownership chain, including every negative, is
exercised in milliseconds.

**The integration tests bring their own.** PGlite is Postgres compiled to WebAssembly, and
`pglite-socket` puts it behind the real wire protocol, so `node-pg-migrate` and the `pg`
client connect unmodified and the migrations, triggers and plpgsql run as Postgres. No
server to install, no container, nothing to configure.

They exist because two bugs got through review without them. The audit chain shipped
`char(31)` where `chr(31)` was meant — every unit test passed and `migrate up` would have
failed on the first run. And `audit_chain_verify` had an OUT parameter named `found`,
which silently shadows plpgsql's built-in `FOUND` boolean; it only failed on the path that
detects tampering, which is the one path that matters. **Anything the database enforces
needs a database to prove it.**

One caveat: PGlite here is PostgreSQL 18 and §23 targets 16. Everything the schema uses is
PostgreSQL 11 or older, so the gap is narrow — but CI should eventually run a real 16.

**Registration and publication are gated differently**, and it is a conformance question
rather than a preference. §14 lists allocation state under Registration; the Publication
rows are content gates only. §7.2 and §14 both say a steward hold "suspends new
registration" and "cannot alter, unpublish, or refuse to serve anything already
published". So a locked or closed allocation stops new names appearing beneath it and does
not stop a version being published on a name already there. The ownership chain applies to
both — only the allocation's own state is waived.

## The bootstrap

`cp.padi.io` holds 70 records across 18 de-facto Prefixes. Spec §7.1 grandfathers them as
allocated, but not to anyone in particular. Design §10.2 says to whom, and
[`src/seed/grandfathered.ts`](src/seed/grandfathered.ts) is that ruling as data:

| Disposition | Prefixes | |
|---|---|---|
| Operator's own | `padi cns haystack dbp kube modbus hello` | Ordinary holdings |
| Operator-held, pending claimant | `onuma ibb kubecns skycentrics c4sb novant openjs` | Released to the evident owner on verification (§8.1). Named publicly so nobody can race the Prefix, without asserting an ownership nobody has verified. |
| Withheld | `proto acme xyz` | Held by the operator, closed to new registration |
| Spec-reserved | `test` | **No allocation row is created, ever** |

## The Phase 0 import (§10.4)

```sh
npm run seed                                                    # allocations first
npm run import -- --file test/fixtures/cp-padi-io-profiles.json --dry-run
npm run import -- --file test/fixtures/cp-padi-io-profiles.json
```

Real Connections bind against the deployed records, so they are imported as **published
versions, marked grandfathered, with their §9.4 shortfalls recorded rather than filled**.
69 names registered, 69 versions published, 1 excluded. Two names — `padi.appliance` and
`padi.device` — are registered with nothing published, which §12.1 describes exactly: "a
registered name with a Draft and nothing else."

**Nothing is invented.** Where a source record has no `Owner`, the version is published
without one and `missing_header_fields` says so. Publication freezes content immutably and
forever (§12.2, spec §6.2), so a plausible-looking substitute inserted at import would be
permanent, and a synthesized `Owner` is a false statement about who is responsible for a
contract. The owner's remedy is available immediately: a Draft persists alongside published
versions, so anyone can complete their Header and publish a conforming version 2.

Three gaps do get resolved, because they have honest answers: `Version` by array position
(spec §6.2 makes assignment the Registry's job), `Status` as Published, and `Pub Date` from
the record's `created` date — **flagged approximate on every version**, since the legacy
format has no publication date.

Counts come in two flavours and both are true: 39 conforming **versions** across 38
conforming **names** (`padi.game.presence` has a complete Header and two versions), and the
per-field shortfall table counts versions, so a two-version record missing a field counts
twice.

Two records do not survive the import:

- **`proto`** — a bare single-segment record. Spec §7.2: a one-segment reference denotes
  an allocation and is never a Profile. The grammar refuses it independently of the seed
  data, so an importer that ignored the exclusion list still could not register it.
- **`test.abc`** — republished as `padi.test.abc`, an existing Padi convention. `test` is
  spec-reserved and never globally resolvable.

Every seeded allocation carries `grandfathered = true` and an audit event naming the
ruling that put it there, so the bootstrap is as inspectable as anything that follows it.

## Layout

```
migrations/          §6 tables, §4.3 audit chain, immutability triggers
src/
  names.ts           §3.1 grammar — the ONLY place a name is validated
  policy.ts          §3.2 reserved and withheld Prefixes
  audit.ts           §4.3 chain, application side
  db.ts              pool and inTransaction()
  part-one/
    authorizes.ts    THE SEAM (§9.3)
    types.ts         OwnershipStore — everything the seam may read
    memory-store.ts  in-memory implementation, for tests and seed data
    pg-store.ts      Postgres implementation
    routes.ts        §9.1 subset + the seam over HTTP
  seed/
    grandfathered.ts §10.2 as data
    run.ts           idempotent, audited loader
test/                75 tests
```

## Three disciplines the code depends on

1. **Governance state must never reach the read path.** A suspended organization, a locked
   allocation, a dispute in flight — none of it may affect resolution of published
   versions, which spec §9.3 answers to any party regardless. `authorizes()` is a
   write-path check only. The moment a resolution query reaches it, the Registry is
   non-conforming (§4.1 rule 1).

2. **No relationship may be inferred from a name's shape** (spec §7.1, §7.7).
   `acme.meter.flow` is registrable whether or not `acme.meter` exists. `names.ts` offers
   no `parent()`, no `children()`, no tree walk. Authorization scopes are **string
   prefixes**, and `scopeCovers('ashrae.135', 'ashrae.1350')` is false — the segment
   boundary is tested, because getting it wrong is a one-character bug that grants
   somebody else's namespace.

3. **Names compare exactly** (spec §7.2). Nothing normalises, case-folds, or trims an
   input on its way to storage. Uppercase is refused with a message, never silently
   lowercased.
