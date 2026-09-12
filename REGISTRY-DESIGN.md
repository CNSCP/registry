# Connection Profile Registry — System Design

**Status:** Draft v0.7 · 11 September 2026
**Normative anchor:** the CNS/CP specification, **2026 revision**, clean reading copy §1–§10, assembled **8 September 2026** from the canon working drafts at that date — §1 v0.9, §2 v0.14, §3 v0.16, §4 v0.18, §5 v0.16, §6 v0.21, §7 v0.18, §8 v0.26, §9 v0.21, §10 v0.18. Where this document and the specification differ, the specification wins and this document is wrong.

> **The anchor is pinned, because the 2026 revision is still in draft and not yet public.** This design is written against one identifiable artifact:
>
> ```
> cnscp_2026_spec_clean_read_s1-10.md
> SHA-256  442043a7c0306f2f9f44a9e923f027a85a02c716baeb130171c6a4b038a712c8
> 134,887 bytes · assembled 8 September 2026
> ```
>
> The anchor and its predecessor live one directory above this repository, outside version control, because the revision is not yet public (§25 Q10); `npm run verify-spec` looks for them there. The prior anchor (26 Aug, `bbeec3f7…22be09b`) is archived as
> `cnscp_2026_spec_clean_read_s1-10_20260826.md`; v0.5 of this document was written against it, and §24.5 records what moved.
>
> Every `spec §n` citation in this document means that file and no other. Without the hash, "the 2026 revision" is a description rather than an identifier: the working copy moves, the citations quietly stop matching, and nothing detects the drift. This is the same argument §4.3 makes for the audit anchor, applied one level up. `registry/scripts/verify-spec.mjs` checks it.
>
> **The public repository is a different document.** [github.com/CNSCP/specification](https://github.com/CNSCP/specification) on `main` carries the **December 2022** draft, which this design does not follow: it numbers the Header §2.3 and Properties §2.4, uses Status values `Testing`/`Active`/`Deprecated`, puts `"Source": "provider"` on each Property, and has no Propagate attribute at all. Building to it produces an incompatible contract — see §25 Q10.

**Companion reading:** [ARETE.md](https://raw.githubusercontent.com/project-arete/sdk/main/ARETE.md) (SDK conventions) · [CNS/CP specification repo](https://github.com/CNSCP/specification) *(2022 draft — superseded, see above)* · [current profiles server](https://cp.padi.io)

**Reference convention:** *spec §7.3* cites the CNS/CP specification. A bare *§12* cites a section of this document.

> **On this revision.** v0.3 was a single flow. v0.4 divided the work into the three parts it naturally has — allocation, authoring, and resolution — because they differ in who runs them, who uses them, how fast they change, and whether the specification constrains them at all. §4 defines the parts and the seams between them; §24 records what changed from v0.2 when the 2026 specification landed.
>
> **v0.7 brings the whole document into the 8 September vocabulary, and records Phase 1's first delivery.** Every section that still described the withdrawn Draft-in-Registry design — §2's vocabulary and invariants, §3.1's grammar, §10.4, §11–§16, §18–§20, §22, §23 — now says what the specification says and what the code does: the Registry holds the entry alone for an unpublished name, publication carries its content, `:unpublished` is never resolved, one irreversible act, scopes `draft:write · publish · deprecate · operator`. §12.1 lists the columns that exist. §20.1 is new: the distribution feed and local instances as built and verified live against `cp.cnscp.io` (11 Sept). §24 is left in its own historical vocabulary and marked so; §24.5 remains the accounting for the revision itself. §25 gains Q12 (the signed anchor).
>
> **v0.6 follows the 8 September spec revision.** The anchor moved (§1–§10 all revised; +52% text), and the deltas land squarely on Parts Two and Three: the Draft is renamed **Unpublished** (token `unpublished`); **the Registry SHALL NOT hold, serve, or answer for unpublished content** — publication now carries its content in the act, and the stored-draft/disclosure-trapdoor design of v0.4–v0.5 is withdrawn; Profiles gain **Channels** (fixed at first publication) and the Property attribute **Default** (contract-bearing); a Profile must carry **at least one Property**; Properties and Channels share **one name space**. §24.5 is the full accounting; v0.7 carried the vocabulary through the whole document.
>
> **v0.5 settles the bootstrap.** A full inventory of the 70 records on `cp.padi.io` (§10.1) resolved the open question that blocked Phase 0. The four rulings are recorded in §10.2, and §3.2's withheld list is updated accordingly. Two findings were not anticipated by v0.4: `test` holds exactly one record, and `proto` is registered as a bare single-segment Profile that spec §7.2 forbids.

---

# Shared foundations

## 1. Purpose and scope

The specification defines a single namespace of Connection Profile names, divided at the top among owners, and requires that Profiles be registered with and resolved from **the Registry** (spec §7.3). It then deliberately declines to define two things:

- **The allocation function.** Spec §7.1: "the act of allocation, the criteria it applies, and the body that performs it are outside this specification." The specification states only that the function exists and is singular.
- **Registry distribution.** Spec §2.2: how a local instance retrieves, caches, or federates content is out of scope.

**This document designs exactly those omissions, plus a conforming Registry implementation.** It is not a competing specification and defines nothing normative.

One constraint governs everything here: **spec §7.5 makes the namespace authority administrative only.** It defines Profiles, registers names, publishes versions, and sets Deprecation, and it "takes no part in any declaration, match, or Connection formed under the Profiles it publishes." Nothing designed here may put the Registry or the allocation body into an operational path. The comparison the specification draws is the IETF: it authors RFCs without sitting in every handshake that implements them.

### Non-goals

- Anything a Governor does — Enroll, Authorize, Declare, Reconcile, Match, Bind (spec §8). This system governs *names and contracts*, never Connections.
- Realm data: Nodes, Contexts, Context Registers, Capabilities, Connections, Property values.
- Any judgment about what Profiles *mean* or whether they are good. The Registry serves the namespace without regard to the identity of the party presenting a name (spec §9.3); quality is the Prefix owner's affair (spec §7.1).

## 2. Concepts and vocabulary

| Term | Source | Meaning |
|---|---|---|
| **Connection Profile / Profile** | spec §4.4 | A named interaction: two complementary roles and the Properties each supplies. |
| **Registry** | spec §4.4, §7.3 | The Connection Profile Registry. One namespace, one Registry, many instances. |
| **Top Level Prefix (TLP)** | spec §7.1 | The first segment of a Profile name. The unit of allocation and ownership. |
| **Unpublished** | spec §6.2, §6.3 | The state at registration and the form in which a Profile is built: unnumbered, mutable without restriction, one per name, persisting after publication as the author's continuing workspace. **Its content lives with its author, outside the Registry** (spec §7.3) — the Registry holds the entry alone. *(The 26 Aug draft called this the Draft and had the Registry store it; withdrawn, §24.5.)* |
| **version** | spec §6.2, §6.3 | A numbered, immutable frozen copy of the unpublished content at the moment of publication. Integer, assigned by the Registry. |
| **Deprecated** | spec §6.3 | A published version excluded from selection for new Connections. Still immutable, still resolvable, existing Connections unaffected. |
| **Publication** | spec §6.3, §7.3 | The author's single act that freezes the unpublished content as a version, assigns it the next integer, and makes it a contract. The act by which content enters the Registry: the document travels with it. |
| **marker** | spec §7.2 | The `cp:` element of a reference. Not a URI scheme, not part of the name. |
| **Realm / Governor** | spec §4.1 | The governed region in which Connections form, and the role holding its rules. Outside this design; named where the system must serve one. |
| **Prefix Owner** | this design | The organization holding an allocated TLP. The specification calls this "the owner" or "the namespace authority" (spec §7.1, §7.5). |
| **TLP Organization** | this design | The Prefix Owner together with its members — the working unit of Part One. |
| **Allocation function** | spec §7.1, designed here | The singular function that allocates TLPs. Operated by the Registry operator in this design. |
| **Authorization record** | this design | The Registry's evidence that a Prefix Owner permits a name to be registered beneath its Prefix. Spec §7.3 requires the authorization exist; its form is undefined, so this design supplies one. |
| **Local instance** | spec §7.3, §7.4 | A Registry instance a Realm resolves from. Plurality of instances creates no plurality of names. |

### Notation

`cp:` is a **marker**, not a scheme — the specification chooses that word deliberately (spec §7.2): a reference resembles a URI but carries none of that machinery, and *prefix* is already taken by the Top Level Prefix. The marker and any version are parts of the *reference*, not of the *name*: the Registry stores and matches `acme.meter.flow`.

References are written in full (`cp:acme.meter.flow`, `cp:acme.meter.flow:2`, `cp:acme.meter.flow:unpublished`); a bare TLP is written as its own reference form (`cp:acme`), because a one-segment reference denotes an allocation (spec §7.1); stored and wire values appear bare.

Following spec §7.2, prose writes *Profile*, never *CP*. The project retains the informal name "CP Registry"; the specification's term for the service is **the Registry**, and that is what this document uses.

### DNS mapping

The specification adopts the domain-name model "read in the other direction: one namespace, divided at the top among its owners, each part organized as its owner sees fit" (spec §7.1), while "following that model generally without adopting the DNS's mechanics."

| DNS | CNS/CP | Who |
|---|---|---|
| ICANN/IANA root — decides who gets a TLD | Allocates Top Level Prefixes; verifies applicants; runs disputes and transfers | **Part One** |
| TLD registry operator (Verisign for `.com`, Google for `.google`) | Holds a TLP; decides what is registered beneath it and by whom | **TLP Organization** (e.g. ASHRAE for `cp:ashrae`) |
| Zone delegation (subdomain NS records) | Owner-granted authorization over a sub-name scope, e.g. `ashrae.135` | Prefix Owner → grantee (§8.3) |
| Registrant (owns `example.com`) | Registers and stewards a Profile name | Authors, in **Part Two** |
| Authoritative + secondary name servers | Resolution from the authoritative store and from local instances | **Part Three** |
| Registrar (GoDaddy) | Intermediary registering Prefixes on behalf of others | **Deliberately vacant** (§25 Q5) |

**Where the analogy ends.** The mapping is about governance; operationally the two are near-opposites. DNS is on the runtime critical path — consulted for every connection, with records that change constantly and caches racing TTLs. The Registry is never on the data path: a Profile is resolved at Declare, and at Match and Bind (spec §7.4) — at binding time, not per message. Once bound, Connections flow without touching the Registry. And where DNS records churn, published versions never change at all — the namespace grows by accretion. The expected shape of the corpus follows: many Profiles created, never modified, seldom resolved, but used all the same, because every binding's correctness rests on the contract being exactly where it was left. The Registry is less a live directory than an archive of contracts: write-once, read-rarely, must-never-be-wrong. Immutability is what makes a disconnected Realm sound — "not a cache that may fall behind [but] a complete and correct holding of everything already in use" (spec §7.4 NOTE) — and it is why this design favors durability and cacheability over low-latency machinery.

### Design invariants

Every one is a specification requirement, not a preference.

1. **A published version is immutable and is never deleted** (spec §6.2, §7.3, §9.3). No unpublishing; supersession and Deprecation only.
2. **Versions are additive: a new version SHALL NOT remove or redefine any Property of a prior version, and every Property it adds SHALL be optional** (spec §6.2). A breaking change takes a new name (spec §7.7).
3. **Version identifiers are integers assigned at publication** — next after the highest already assigned. The author does not choose (spec §6.2).
4. **An unpublished form exists per name, persists after publication, and is mutable without restriction** (spec §6.2, §6.3).
5. **The Registry holds and answers for published versions only. Of an unpublished name it holds the entry alone, and it SHALL NOT hold, serve, or answer for unpublished content** (spec §7.3). The content is the author's own; a reference to it (`:unpublished`) is one the Registry never resolves (spec §7.2).
6. **The Registry refuses only on grounds the specification states** (spec §9.3), and serves without regard to the identity of the party presenting a name.
7. **A name of fewer than two segments is never registered** (spec §7.2, §9.3). One segment denotes an allocation.
8. **Registration requires the Prefix owner's authorization** (spec §7.3, §9.3).
9. **Same name and version means one content commitment**, and independent parties must be able to detect whether the copies they hold agree (spec §9.3).
10. **The Header changes after publication only in its lifecycle and stewardship fields** — Status (one way, as spec §6.3 provides), Owner and Website (spec §6.6, §9.3). Nothing fixed by publication moves.
11. **The system is administrative only** (spec §7.5): never in an operational path.
12. **Every mutating action is audited.** *(This design's own addition; the specification does not require it.)*

## 3. Namespace, references, and allocation rules

Shared by all three parts: Part One allocates the first segment, Part Two registers names beneath it, Part Three serves them.

### 3.1 Reference and name grammar

Per spec §7.1 and §7.2:

```
reference    = "cp:" name [ ":" version-part ]     ; the citable form
             / "cp:" tlp                            ; one segment: an allocation, never a Profile
name         = tlp 1*("." sub-segment)              ; stored and matched form; two segments minimum
tlp          = segment
sub-segment  = segment                              ; the owner's business: any shape, any depth
version-part = 1*DIGIT                              ; integer, assigned by the Registry at publication
             / "unpublished"                        ; reserved token; never a version identifier
segment      = 1*( %x61-7A / %x30-39 / "-" )        ; lowercase a-z, 0-9, hyphen
```

- `cp:acme` — the **allocation** held by Acme. Never a Profile; the Registry SHALL NOT register it as one (spec §7.2).
- `cp:acme.meter.flow` — a Profile name, no version: leaves the version to selection among published versions (spec §8.6), and is the common form.
- `cp:acme.meter.flow:2` — published version 2: a specific, permanently unchanging contract.
- `cp:acme.meter.flow:unpublished` — the unpublished form, meaningful only where a Realm's rules permit binding against it (spec §6.3); a reference the Registry never resolves (spec §7.2).

Version identifiers are integers and `unpublished` is a reserved token, so the forms can never collide (spec §7.2). *(The 26 Aug draft's token was `draft`; the Registry refuses it with a pointer to the rename.)* **Names are compared by exact string comparison** everywhere (spec §7.2); lowercase is the rule, which keeps exact comparison consistent with the ownership model. **Uppercase `CP:` forms are documentary** — workstream identifiers, never resolvable Profiles (spec §7.2) — and are not accepted.

**No requirement on shape or depth below the Prefix.** Spec §7.1: an owner goes on "assigning sub-names as it sees fit," and the specification "places no requirement on the shape or depth of a name below its Prefix." Therefore:

- `acme.meter.flow` may be registered whether or not `acme.meter` exists. Interior names need not be Profiles, and no parent-child relationship is enforced.
- No relationship between Profiles may be inferred from their names (spec §7.7): `acme.chiller2` is not a successor to `acme.chiller`, or related to it at all. Lineage, if wanted, is a documentary Header field.

Operational limits, not from the specification: name ≤ 128 bytes, ≤ 8 segments, each segment ≤ 63 bytes, no leading or trailing hyphen. Published as operator policy (§9.2) so a refusal is never a surprise, and loose enough that no plausible naming scheme meets them.

### 3.2 Reserved Prefixes

The specification reserves exactly two, and both SHALL NOT be allocated (spec §7.1):

| Prefix | Rule |
|---|---|
| **`example`** | Documentation only. Every Profile named in the specification and its training material lives here; **nothing under it resolves**. |
| **`test`** | Local exercise; **never globally resolvable**. Unrelated to the Unpublished state — `test` is a place in the namespace, Unpublished is a stage in any Profile's lifecycle. |

Beyond those, the allocation function may withhold Prefixes as policy (spec §7.1). This design withholds:

| Class | Prefixes | Rationale |
|---|---|---|
| Infrastructure | `cp`, `cns`, `realm`, `arete`, `registry`, `registrar`, `local`, `internal` | Reserved against future infrastructure naming and confusion with reference syntax. |
| Path-shadowing | `console`, `assets`, `profiles`, `distribution`, `health`, `well-known`, `operator` | A single dotless segment resolves to the allocation it denotes (§19.1), so any reserved path must also be a withheld Prefix or it would be shadowed. Extend both lists together. |
| Documentary | `acme`, `xyz` | Conventional fake-company names, serving the same purpose as spec-reserved `example`. `xyz.ics` cites `www.example.com` as its website. Withheld so neither can later be allocated to a real party and be misread. |
| Operator-held | `padi`, `hello`, `proto` | `padi` and `hello` are the operator's own. `proto` is withheld rather than allocated because its contents come from four unrelated organizations (§10.2 ruling 2). |
| Restricted | Single-character Prefixes; a published trademark watch list | Allocatable only on review, with recorded rationale. |

**Withheld is not the same as reserved.** The two spec-reserved Prefixes SHALL NOT be allocated, ever, by anyone. A withheld Prefix is this operator's policy choice under spec §7.1 and may be released later by a recorded decision — but while withheld it is held by the operator, so nothing beneath it is ownerless.

### 3.3 Rules that bind the whole namespace

- A Prefix is allocated to exactly one party at a time (spec §7.1).
- **A Prefix allocated before the specification takes effect is an allocated Prefix within the meaning of spec §7.1.** Existing holdings are grandfathered by the specification itself; what this design must decide is who the holder of record is (§25 Q1).
- **A name with published versions is permanent**, and its versions are never deleted (spec §7.3). The name can never be reissued to mean something else.
- **A name never published may be released by its author** (spec §7.3).
- **Registration date is public but confers nothing** (spec §7.3). A name held unpublished for years earns no precedence by its age.

## 4. Three parts, and the seams between them

The work divides into three systems. They differ in who runs them, who uses them, how often they change, and — decisively — whether the specification constrains them at all.

| | **Part One — Allocation** | **Part Two — Authoring** | **Part Three — Resolution** |
|---|---|---|---|
| **Question it answers** | Who holds this Prefix, and who may act under it? | What does this Profile say, and when does it become a contract? | What does a Governor get when it resolves a name? |
| **Normative status** | Outside the specification (spec §7.1, §7.5). Policy, freely revisable. | Spec §6.2, §7.2, §7.3; conformance per spec §9.3. | Spec §7.4; conformance per spec §9.3. |
| **Users** | Organization admins; operator staff. Human, administrative, some of it legal. | Authors — human, programmatic (CI), and AI agents alike (§15.1). API-first; any UI is one client among several. | Governors and SDKs. Machines only. |
| **Who runs it** | The operator, centrally, one instance. | The operator, centrally, one instance. | The operator **and everyone else** — local instances inside Realms, regions, air-gapped sites. |
| **Change cadence** | Slow; policy changes are announced. | Moderate; constrained by conformance. | Slowest of all — its wire contract is deployed software others own. |
| **If it stops** | No onboarding, no transfers. Tolerable. | No publishing. Tolerable. | Realms cannot form new Connections — which is why spec §7.4 requires they be able to run it locally. |

### 4.1 The seam between One and Two

Part Two asks Part One exactly one question:

> *Does an authorization exist for this actor to register or publish this name, under an active allocation?*

That is spec §7.3's requirement made a question: "what the Registry requires is that the authorization exists," while the specification deliberately declines to define its form. §7.3 requires it for every act on a name — registration, publication, Deprecation, a stewardship change, release — and the seam answers the same question for all of them (§11); registration and publication are the two that block on it, the rest have a local fallback (§4.1 rule 2). The seam therefore sits exactly where the specification already put a boundary.

Everything else flows the other way, as events: a transfer completes in Part One, and Part Two reacts by updating the `Owner` stewardship field on affected versions and dropping authorization scopes to `offered`. **One query in, events out.** Part Two never writes into Part One, and neither reaches into the other's tables.

Two rules keep the seam honest:

1. **Governance state must never reach the read path.** A suspended organization, a locked allocation, a dispute in flight — none of it may affect resolution of published versions, which spec §9.3 answers to any party regardless. This is easy to violate accidentally with a naive join across the seam.
2. **The authorization query is the only synchronous coupling.** Part Two must remain able to serve reads and edits when Part One is unavailable; only registration and publication block.

### 4.2 The seam between Two and Three

Part Three consumes what Part Two produces and has **no dependency on Part One at all.** The interface is the distribution feed (§20): a snapshot plus an append-only journal of published versions, deprecations, stewardship-field changes, name registrations and releases, and Prefix allocations. It flows one way.

### 4.3 Cross-cutting: audit and verifiability

One append-only, hash-chained log spans Parts One and Two: `actor, actor_kind, principal, org_id, action, subject_type, subject_id, before_hash, after_hash, at, request_id, prev_event_hash`, written in the same transaction as the change it records. `actor_kind` distinguishes `human · service · agent · operator`, and `principal` names the human on whose behalf a non-human actor acted — so "who published this" always has an answer that ends in a person (§15.1). The operator periodically publishes a **signed anchor** of the chain head.

Part Three distributes the anchor but writes nothing. Together with per-version content hashes, the anchor is how independent parties detect whether the copies they hold agree — the mechanism spec §9.3 requires without defining.

### 4.4 Hosts and surfaces

Two canonical hosts, and the line between them is the normative one: `tlp.` is the function the specification places outside itself (spec §7.1, §7.5); `cp.` is the conforming Registry, whose bullets in spec §9.3 span registration, publication, and resolution alike.

| Host | Serves | Parts |
|---|---|---|
| **`tlp.cnscp.io`** | Console UI and API for allocation and organizations — applications, verification, members, authorization scopes, renewals, transfers, disputes | One |
| **`cp.cnscp.io`** | Console UI and API for authoring, plus resolution and distribution | Two and Three |

Each host carries its own console and its own API on a single origin, so no console makes a cross-origin call and no CORS configuration sits between a user and their work.

**Routing on `cp.` is decided by one rule: does the first path segment contain a dot?** A dot means resolution; no dot means console, API, or infrastructure. The two can never collide, because a Profile name always has at least two segments (spec §7.2) and no console or API path contains a dot. Reserved dotless prefixes: `/console`, `/assets`, `/profiles`, `/distribution`, `/health`, `/.well-known`, `/operator`. Authoring needs none of its own: it addresses the same paths as resolution and separates by method (§15).

**Credentials.** Session cookies are scoped to `/console` and are neither sent to nor honored on resolution paths; the edge strips them there, so a credential can never enter a cache key. Machine clients use bearer tokens exclusively (§15.1). The console authenticates by OIDC and then calls the same API as every other client — it holds no privileged path of its own.

**One URL per Profile, for people and machines alike.** Typing `cp.cnscp.io/acme.meter.flow` into a browser shows a readable page; the same URL fetched by a Governor returns the document. The two are separated by `Accept` (§19.2), not by different addresses, because the address *is* the Profile's citation — the thing that goes in a specification, an email, or a slide, and works for whoever follows it. `/console` is for authoring, not for viewing.

The rendered page presents the document; it never summarizes it. ARETE.md's warning that summarized views lose key-presence flags is exactly the hazard, so every Property, every attribute, and every version appears explicitly, and the raw document is one click away and named as the contract.

**Two conformance profiles of the `cp.` contract**, so that a local instance is understood as complete rather than deficient:

- **Resolution profile** — every `GET`, per §19 and §20. What every instance implements, `cp.acme.com` included, and what spec §7.4 requires a Governor be able to run locally.
- **Authoritative profile** — the resolution profile plus every other verb on those same paths (§15), plus the console. Only `cp.cnscp.io` implements it.

A local instance may serve a read-only browse view; it never serves the authoring console, and a write to it returns the authoritative host's URL. `cp.<organization>` becomes the recognizable convention for a Registry instance.

### 4.5 Building order

Because the seam in §4.1 is a single query, **Part One can be reduced to its spine**: the ownership tables and `authorizes()`, without any of the governance workflows. Part Two calls the same interface it will always call, and when applications, verification, transfers and disputes arrive, nothing in Part Two changes. That is what makes the near-term plan possible (§25 Phase 0): stand up Parts Two and Three against a Part One that answers the ownership question and nothing else, and unblock Arete gateway and widget work in weeks rather than after the governance workflows are built and tested. §10.3 draws the line.

This is a split in design and build units, not necessarily in deployment. One codebase and one database is fine to start; the discipline is that Part Two reaches Part One only through that one interface.

---

# Part One — Allocation and Organizations

*Outside the specification (spec §7.1). Everything here is this design's own policy, written to be published so the criteria are knowable in advance.*

## 5. Actors

| Actor | Capabilities |
|---|---|
| **Applicant** | An unverified party with an open Prefix application and nothing else. |
| **Org admin** | Manage members, grant and revoke authorization scopes, set the organization's publication policy, request renewal, initiate transfer. |
| **Org member** | Membership is itself authorization to act under the Prefix in Part Two, unless the owner has narrowed it with scopes. |
| **Operator — Reviewer** | Verification decisions; restricted-Prefix requests. |
| **Operator — Steward** | Reviewer rights plus disputes, forced transfers, suspensions, and reserved/restricted list changes. Two-steward rule on irreversible acts. |

## 6. Data model

### 6.1 `organization`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | text | Legal/display name |
| `website` | text | Used in verification |
| `contact_email` | text | |
| `status` | enum | `applied · verified · active · suspended · dissolved` |
| `verification` | jsonb | Method, evidence, verified_at, verified_by |
| `created / modified` | timestamptz | |

### 6.2 `member`

Organization ↔ user with role `author · admin`. Authentication identity (OIDC subject) lives on `user`; authorization lives here.

### 6.3 `allocation`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `tlp` | text unique | The Prefix string, e.g. `acme`; cited as `cp:acme` |
| `org_id` | uuid → organization | Current holder |
| `status` | enum | `requested · reserved · active · locked · redemption · released` |
| `class` | enum | `standard · restricted · operator · reserved` |
| `allocated_at / expires_at` | timestamptz | Renewable term (§8.2) |
| `grandfathered` | bool | Allocated before the specification took effect (spec §7.1) |

### 6.4 `authorization_record`

The Registry must check that an owner's authorization exists (spec §7.3), but the specification does not define its form — so this design supplies one. Owners with simple needs never create a record: membership in the owning organization is authorization enough.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `allocation_id` | uuid → allocation | |
| `scope` | text | A name or sub-name scope, e.g. `ashrae.135`: covers that exact name and any name beginning `ashrae.135.` — **string prefix, not a tree**; no interior name need exist |
| `grantee_org_id` | uuid → organization | |
| `status` | enum | `offered · active · revoked · expired` |
| `granted_by / granted_at / expires_at` | | Revocable at will; revocation never affects already-published versions |

## 7. Lifecycles

### 7.1 Organization

```
applied ──verify──► verified ──first allocation──► active
   │                              ├─suspend (steward)──► suspended ──reinstate──► active
   └─rejected                     └─dissolve──► dissolved
```

- `suspended` freezes management writes for the organization. It **never** affects resolution of published versions: those are immutable, permanent, and answerable to any party regardless of what has become of their author (spec §9.3). Governance churn must be invisible to resolvers (§4.1 rule 1).
- `dissolved` sends every allocation the organization holds into redemption.

### 7.2 Allocation

```
requested ──approve──► reserved ──setup complete──► active
    │                                 ├─dispute filed──► locked ──decide──► active | transferred
    └─denied                          ├─not renewed──► redemption ──lapse──► released
                                      └─transfer──► active (new holder)
```

- `reserved` holds a Prefix for 30 days during onboarding so verification cannot be raced; then auto-releases.
- `locked` suspends transfer and *new registration*. Published versions continue to resolve untouched.
- `redemption` runs 90 days, during which only the lapsed holder may renew; nothing else may claim the Prefix.
- **A released Prefix with published names beneath it is not re-allocatable without steward review.** Those names are permanent and their versions immutable (spec §7.3); a new holder inherits a branch it did not write and cannot alter, and must be told so explicitly.

## 8. Workflows

### 8.1 Verification

1. Applicant submits legal name, website, contact, and the Prefix requested.
2. Automated challenge: a DNS TXT record or `/.well-known/cnscp-registry-challenge` carrying a signed nonce — proof of control of the claimed web identity.
3. Reviewer confirms the requested Prefix is not a deliberate collision with an existing holder or an entry on the published trademark watch list.
4. Outcome recorded with evidence, and audited.

Verification level (`domain-verified` at v1; legal-entity attestation later) is a public fact about the allocation. It is **not** exposed inside Profile documents: no Header field beyond Name, Version and Status participates in matching (spec §6.6), and a Governor may not refuse a declaration on the basis of which Profile is named (spec §5.3), so the system must not slip a trust signal into the resolution path where it could be mistaken for one.

### 8.2 Allocation and renewal

- First-come-first-served for `standard` class, subject to automated checks: grammar, reserved and withheld lists, confusable-collision guard against existing Prefixes, and applicant status `verified` or `active`.
- `restricted` class requires reviewer approval with recorded rationale.
- Annual renewable term. Renewal is administrative — it keeps contact and verification current — and never an auction: lapse leads to redemption, never resale. Warnings at 60/30/7 days.

### 8.3 Sub-name authorization

Spec §7.3 requires only that the owner's authorization exist; how an owner governs registration beneath its Prefix "is its own affair" (spec §7.1). The system therefore offers a mechanism without mandating one:

- Default: any member of the owning organization may register any name beneath the Prefix. Small owners need nothing more.
- Optional: the owner grants a scope to another organization — `ashrae.135` covers that name and anything beginning `ashrae.135.`. Grantee members then register and publish within the scope. **Scope is a string prefix, not a tree**: nothing requires `ashrae.135` itself to be registered, and no interior name need exist.
- Revocation takes effect for future acts only. Published versions are immutable and unaffected — governance never rewrites history.
- Scopes may not overlap, and are not re-delegable at v1. *Watch item:* the standards-body pattern (`ashrae` → committee → working group) may need chains sooner than expected (§25 Q6).
- On transfer, scopes drop to `offered` for re-affirmation by the new holder.

### 8.4 Transfers

- **Voluntary:** initiated by the holder's admin, accepted by the receiving organization's admin, executed after a 7-day cooling window; cancellable, audited.
- **Forced:** dispute outcome, legal order, or recovery from a dissolved organization. Two-steward sign-off, permanent record.
- Published versions travel with the Prefix byte-identical. A transfer changes who may register and publish next; it changes nothing already published. The new holder may update the stewardship Header fields — `Owner` exists as a mutable field precisely because "a Prefix may change hands" (spec §6.6).

### 8.5 Disputes

1. A verified organization files against an allocation on stated grounds: trademark conflict, verification fraud, or abandonment.
2. Allocation → `locked`; both parties notified; 21-day response window.
3. Steward panel decides: dismiss, transfer, or suspend the holder.
4. Case record in the audit log; decisions published.

Throughout, published versions under the disputed Prefix continue to resolve normally. A dispute is about who holds the name next, never about what the name already means.

## 9. API

### 9.1 Organization and allocation management (OIDC → membership)

```
POST   /orgs                                apply
GET    /orgs/{org} · PATCH                  contact fields
POST   /orgs/{org}/members · DELETE …/{user}

POST   /orgs/{org}/allocations              request a Prefix
GET    /allocations/{tlp}                   holder + status (public)
POST   /allocations/{tlp}/renewal
POST   /allocations/{tlp}/transfers · /transfers/{id}/accept|cancel
POST   /allocations/{tlp}/authorizations    grant a sub-name scope
POST   /authorizations/{id}/accept|revoke

GET    /orgs/{org}/audit
```

### 9.2 Operator plane

```
GET/POST /operator/verifications/{id}/approve|reject
GET/POST /operator/disputes · /disputes/{id}/decide         two-steward rule
POST     /operator/allocations                              allocate a Prefix by operator ruling — BUILT (Phase 0 form: evidence
                                                            required, policy consulted, one audited transaction; §10.2's mold)
POST     /operator/allocations/{tlp}/lock|suspend|force-transfer
GET/PUT  /operator/policy/reserved · /policy/restricted · /policy/limits
GET      /operator/audit                                    full chain, export
```

There is deliberately no endpoint anywhere in the operator plane to alter, unpublish, or withhold a published version. Spec §9.3 forbids all three, so the capability should not exist in the codebase — its absence is the enforcement.

### 9.3 The internal interface Part Two calls

```
authorizes(actor, name) → { allowed, allocation_id, reason }
```

Resolves the whole chain: actor → organization membership → allocation of the name's TLP, or an authorization scope covering the name → allocation status is `active`. A broken link denies. This is the only synchronous call across the seam (§4.1).

## 10. Bootstrapping the existing namespace

### 10.1 What is actually there

A full inventory of `cp.padi.io` on 31 August 2026: **70 records across 18 de-facto Prefixes.** The shape of the estate matters more than its size, because three facts decide most of the import.

| Prefix | Records | Evident author | Disposition (§10.2) |
|---|---|---|---|
| `padi` | 27 | Padi, Inc. | Allocated to the operator |
| `proto` | 14 | Padi + ControlBEAM + Digital Twin Consortium + Jitsuin | Withheld, operator-held |
| `onuma` | 6 | ONUMA | Operator-held pending verification |
| `cns` | 3 | Padi, Inc. | Allocated to the operator |
| `ibb` | 3 | IBB Project | Operator-held pending verification |
| `acme` | 2 | *fictional* | Withheld (documentary) |
| `haystack` | 2 | Padi, Inc. | Allocated to the operator |
| `kubecns` | 2 | Tacos Linux | Operator-held pending verification |
| `skycentrics` | 2 | SkyCentrics, Inc. | Operator-held pending verification |
| `c4sb` | 1 | C4SB | Operator-held pending verification |
| `dbp`, `hello`, `kube`, `modbus` | 1 each | Padi, Inc. | Allocated to the operator |
| `novant` | 1 | Novant.io | Operator-held pending verification |
| `openjs` | 1 | The OpenJS Foundation | Operator-held pending verification |
| `test` | 1 | Padi, Inc. | Spec-reserved; record relocated |
| `xyz` | 1 | *fictional* | Withheld (documentary) |

Three findings, in order of how much they change the plan:

1. **`test` holds one record** — `test.abc`, "CNS/CP simple test profile", Padi's own, created 29 October 2022. v0.4 treated this as a live conflict requiring a migration story. It requires a rename.
2. **`proto` is registered as a bare single-segment Profile.** A record literally named `proto` exists. Spec §7.2 is explicit that a one-segment reference denotes an allocation and is never a Profile, and §7.2 says the Registry SHALL NOT register it as one. It cannot be imported as a Profile under any ruling.
3. **The version machinery starts clean.** No record has `approved` or `active` set, and only two of seventy carry more than one entry in `versions`. The import is therefore ~70 names each entering at version 1 — not a version-history reconstruction problem.

Two further notes for the importer. `ibb` carries `.v1` inside names (`ibb.zone.data.temperature.v1` alongside `ibb.zone.temperature`); per spec §7.7 no relationship may be inferred between them, so all three import as unrelated names and the `.v1` stays a literal segment. And several records lack `company`, `title`, or `modified` — the importer must tolerate absence rather than synthesize.

### 10.2 Rulings

Spec §7.1 grandfathers pre-specification Prefixes as allocated, but not to anyone in particular. These four decisions say to whom, and are the answer to what v0.4 filed as its blocking open question.

**1 — `test.abc` moves to `padi.test.abc`.** Padi already uses `padi.test.*` for exactly this purpose (`padi.test.chat.room`, `padi.test.hvac.rtu`, `padi.test.propagate`, `padi.test.realm.info`, `padi.test.status`), so the record lands in an established convention rather than a new exception. `test.abc` stops resolving. The record is Padi's own, so no third party's contract is broken, and `test` becomes cleanly unallocatable per spec §7.1 with no grandfathered exception to carry forward.

**2 — `proto` is withheld and operator-held; its sub-names import; the bare record does not.** The record named `proto` is dropped, because spec §7.2 forbids registering it. The fourteen sub-names import unchanged so existing prototypes keep resolving. `proto` is not *allocated* to Padi, because its contents come from four unrelated organizations and allocating it would make the operator the owner of Digital Twin Consortium and Jitsuin content; it is withheld, which is honest about what it is. A shared Prefix is the sandbox pattern v0.3 removed, so `proto` is closed to new registration and no successor is offered.

**3 — `acme` and `xyz` are withheld as documentary.** Both are conventional fake-company names and neither has a real holder to find; `xyz.ics` cites `www.example.com`. They join `example` in the withheld list (§3.2) rather than being allocated. `hello` is Padi's own and allocates to the operator normally.

**4 — Prefixes with real external claimants are operator-held, released on verification.** `c4sb`, `ibb`, `kubecns`, `novant`, `onuma`, `openjs`, `skycentrics` are allocated to the operator at import with `grandfathered = true`, and released to the evident owner when that organization verifies under §8.1. Nothing is claimed on anyone's behalf and the allocation record is truthful from the first day. Published versions beneath them resolve throughout, since resolution never consults governance state (§4.1 rule 1) — a claimant's Profiles keep working whether or not they ever come to claim the Prefix.

Every one of these is written into the audit chain (§4.3) as an operator act with recorded rationale, so the bootstrap is as inspectable as anything that follows it.

**Per-Prefix dispositions were reviewed individually on 31 August 2026**, and six that rested on thin evidence were confirmed: `haystack` and `modbus` stay ordinary operator holdings rather than being parked, since Padi authored the records and a transfer later is a normal §8.4 operation; `cns` is allocated to the operator *and* on the §3.2 infrastructure withheld list, which is what withholding looks like in practice; and `kubecns` names Tacos Linux on the strength of one record's company field, which is provisional until §8.1 verification makes it real.

**That review surfaced a gap in §8.1 worth naming.** `ibb` and `skycentrics` are marked for release on verification, but the only websites on record for either are Google Docs — and §8.1 offers one method, a DNS or well-known challenge against a domain. As things stand their disposition promises a path neither can walk. The decision was to keep the marking and state the obstacle in the published rationale, so the claimant learns what is needed from their own allocation page (§19.3). The general problem remains: plenty of real bodies — working groups, projects, consortia — have no domain they control, and an allocation function with exactly one verification method cannot serve them. See §25 Q9.

### 10.3 What gets built now, and what waits

The seam in §4.1 is a single query, so v0.4 proposed backing it with a hand-maintained `tlp | org | members | status` table. The inventory above argues for slightly more: the ownership graph the rulings describe — operator-held versus allocated, grandfathered versus not, pending verification versus released — does not fit a flat seed table without immediately becoming a worse version of the real schema.

So Part One is built as its **spine**: the real `organization`, `member`, `allocation`, and `authorization_record` tables of §6, the real `authorizes()` of §9.3, the name grammar of §3.1, the policy lists of §3.2, and the audit chain of §4.3. What waits for Phase 2 is every *workflow* in §8 — verification challenges, applications, renewal, redemption, transfers, disputes — and the operator plane of §9.2. Those are UI and process; the spine is data and the seam.

The rule that made the stub safe still holds and is what matters: Part Two calls `authorizes()` and nothing else, from the first commit, and never learns what answers it.

### 10.4 The import policy

*Settled 31 August 2026, on the finding in §19.2 that no deployed record satisfies spec §9.4.*

**Real Connections bind against these records today.** That fact decides the rest: they must keep resolving through the import, which rules out leaving them unpublished (spec §7.3: the Registry holds no unpublished content, so an unpublished import would be unresolvable) and rules out holding back the 32 that cannot fill their Header. And it sharpens the constraint on the other side — a version's content is frozen at publication and immutable forever (§12.2, spec §6.2), so anything invented at import is invented permanently.

So: **imported as published versions, marked grandfathered, with their shortfalls recorded rather than filled.**

| Gap | Resolution | Honest? |
|---|---|---|
| `Version` | Array position: the first version object becomes version 1. | Yes — spec §6.2 makes assignment the Registry's job, and the author never chose one. |
| `Status` | `Published`. | Yes — they are in service, and Published is the state a version is in once publication has made it a contract (spec §6.3); these are contracts real Connections hold. |
| `Pub Date` | The record's `created` date, **recorded as approximate**. | Approximately. The legacy format has no publication date; `created` is when the record appeared. The import record says so for every version. |
| `Sample` | Omitted, not synthesized. | Yes — spec §6.4 takes no view of Sample, so absence is a formatting matter (Q11). |
| `Owner`, `Title`, `Provider`, `Consumer`, `Description`, `Website` | **Left absent where the source has none.** The shortfall is recorded on the version and published on its page. | Yes — and this is the point. A synthesized `Owner` is a false statement about who is responsible for a contract. |

**What the import actually produces:** 69 registered names (70 less the excluded bare `proto`), of which two — `padi.appliance` and `padi.device` — carry no version content at all and are registered with nothing published. That state is legitimate and spec §9.4 describes it: "a registered name whose content has not yet been checked" — an entry, holding nothing (§12.1). Of the 69 published versions, **39 conform and 30 do not**; those 39 span 38 distinct names, because `padi.game.presence` has a complete Header and two versions. Version count and name count are different numbers and neither substitutes for the other.

Thirty-eight names will carry a complete Header; the rest will not, and will say which fields they lack. A conforming Registry is required to serve them either way: spec §9.3 lets a Registry refuse only on grounds the specification states, and "the Header was incomplete when this predated the requirement" is not among them. Spec §9.4 conformance is a property of the *Profile*, not a gate the *Registry* applies — §14 already draws that line.

**The remedy is the owner's, and it is available.** The unpublished form persists alongside published versions (spec §6.3), in the owner's own hands, so any owner can complete the Header in their working copy and publish a conforming version 2 whenever they choose. Nothing about this import forecloses that; it records a starting position rather than fixing one.

Every imported version carries its findings in the audit chain and on its allocation page, so the namespace is honest about what it holds from the first day rather than appearing conformant and not being.

---

# Part Two — Profile Authoring

*Inside the specification. Conformance obligations from spec §9.3 apply to everything here.*

## 11. Actors

| Actor | Capabilities |
|---|---|
| **Author** | Register names within the scope the owner has authorized; publish versions; set Deprecation; steward Owner and Website. The unpublished work itself happens outside the Registry (spec §7.3). |
| **Machine author** | A CI job or AI agent holding scoped credentials and acting for a named human principal. Same API, narrower scopes — normally `draft:write` only: registration, release and stewardship, none of the irreversible acts (§15.2). |
| **Owner admin** | Author rights over the whole Prefix, plus the organization's own publication policy (§14). |

Every write resolves `authorizes(actor, name)` (§9.3) first. Reads of published versions resolve nothing — they are answered to any party (spec §9.3).

## 12. Data model

### 12.1 `profile`

One row per registered name — **the entry, and nothing else.** Spec §7.3: "Of an unpublished name it holds the entry alone — the name and its registration date — and it SHALL NOT hold, serve, or answer for the content of an unpublished Profile." There are no content columns on this table, and that absence is the enforcement: the Registry cannot hold what it has nowhere to put. *(v0.4–v0.5 stored the Draft here with a three-state disclosure flag and an irreversible trapdoor to `public`; migration 6 dropped those columns when the 8 Sept revision moved unpublished content out of the Registry — §24.5.)*

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | text, unique among live rows | The registered name, ≥ 2 segments; never changes. Uniqueness is a partial index over `discarded_at IS NULL` (migration 8), so a released name is free to register again (spec §7.3) while the released row stays as history |
| `allocation_id` | uuid | Owner chain root, as returned by `authorizes()` at registration |
| `registered_at` | timestamptz | Public fact (spec §7.3); confers nothing |
| `registered_by` | uuid → app_user | The registrant the seam confirmed; the local fallback for edit-class acts during a Part One outage (§4.1 rule 2) |
| `imported_from` | text null | §10.4: the name this record was served under on `cp.padi.io`, where it differs |
| `discarded_at` | timestamptz null | Set only if never published; releases the name |

There is deliberately **no status column here.** Status is a property of a version (spec §6.6 Header). A row with zero published versions is a registered name whose content has not yet been checked (spec §9.4) — an entry the Registry answers for by name and date, and nothing more.

### 12.2 `profile_version`

| Field | Type | Notes |
|---|---|---|
| `profile_id` | uuid → profile | |
| `version` | int | `max(version) + 1` within the profile, under a row lock on the parent. The author does not choose it (spec §6.2). |
| `content` | jsonb | The document as published: Header, Properties, Channels — with Version, Pub Date and Status stamped by the Registry before hashing (spec §6.6; a copy that leaves the Registry still says which version it is) |
| `served_bytes` | bytea | The canonical serialization actually served, stored verbatim |
| `content_hash` | text | SHA-256 over the canonical form — the detection mechanism spec §9.3 requires |
| `status` | enum | `published · deprecated` — no other value exists, and there is no path back |
| `published_at` | timestamptz | Exactly the stamped Pub Date |
| `header_owner / header_website` | text | The two stewardship fields, mutable post-publication (spec §6.6) |
| `grandfathered · pub_date_approximate · missing_header_fields` | | §10.4: recorded at import, published on the version's page, never filled |

**Immutability enforcement.** A trigger rejects UPDATE of every column except `status` (published → deprecated, one-way) and the two stewardship fields, and rejects DELETE unconditionally. This is narrower than a blanket rejection, deliberately: spec §6.6 *permits* Owner and Website to change after publication, and forbidding it would be non-conforming in the other direction.

## 13. The Profile lifecycle

Following spec §6.3 and §7.3 directly. The lifecycle is one-way: Unpublished → Published → Deprecated.

```
register name ──► entry (name + date; the Registry holds nothing else)
   (owner auth,        │
    ≥2 segments)       ├──publish(document)──► version 1 ──deprecate──► deprecated
                       │      (content checked, integer assigned,
                       ├──publish(document)──► version 2   immutable, permanent)
                       │
                       └──release (only if never published) ──► name released

                  the unpublished form: with the author, outside the Registry,
                  mutable without restriction, persisting across every publication
```

### 13.1 Registration

Registration claims the name (spec §7.3) — the name, and nothing else. The Registry checks the name's grammar (two segments or more, lowercase; spec §7.2), that the Prefix is allocated and not withheld, that the name is free, and that the Prefix owner's authorization exists (spec §7.3) — §14 is the complete list, and it is short by design. It does not evaluate content, because at registration it holds none: the name enters the Unpublished state (spec §6.3), and its content, wherever the author keeps it, is the author's own.

### 13.2 The unpublished form — outside the Registry

**The workspace, held by the author, at the name its versions will occupy.** The author "MAY add, remove, or redefine its Properties and Channels as often as the work requires: it is not a contract" (spec §6.3). Testing happens against the name that will eventually be published — which is why this design has no separate development namespace (§24) — but the Registry takes no part in it: "Its content lives with its author, outside the Registry, and reaches another party only as the author conveys it" (spec §6.3, §7.3). How it is conveyed, and in what form, is outside the specification. A Realm that binds an unpublished Profile does so under its own published rules and publishes what it took in (spec §6.3) — so the disclosure consequence the 26 Aug draft placed in the Registry now lives with Governors, where the binding happens.

**The unpublished form persists after publication.** A version is "a frozen copy of the unpublished content at the moment of publication; the unpublished form persists, still mutable" (spec §6.3) — shaped onward toward the next version, in the author's hands.

### 13.3 What the Registry answers for an unpublished name

The entry alone: that the name is registered, and since when (spec §7.3, §9.3). `GET /<name>:unpublished` is "a reference the Registry never resolves; only a Realm holding its content can" (spec §7.2) — and because the Registry holds nothing, this is not a permission question: no credential changes the answer, and `PUT /<name>:unpublished` is refused with the architecture, not a 403. The token `unpublished` is reserved in the version's place and no version is ever numbered by it.

*Withdrawn (§24.5):* v0.4–v0.5's three disclosure states and the irreversible trapdoor to `public` on authorizing a non-operated Realm. Nothing to disclose remains in the Registry.

### 13.4 Publication

The author's single act, and **the act by which content enters the Registry** (spec §7.3): the document travels in the request, is checked against every publication gate (§14), and is frozen as a version with the next integer assigned by the Registry (spec §6.2, §6.3) — or refused, with the refusal explaining itself and **the Registry retaining nothing**. The Registry stamps the assigned Version, the Pub Date and Status `Published` into the document before hashing it, so the frozen copy carries its own identity (spec §6.6). Once a first version exists, only an additive document can be published as the next version — the constraint applies at the moment of publication and never restricts what the author's working copy may contain before it.

**Additivity.** The candidate is diffed against **every prior published version** (spec §6.2 measures the rule that way, and the implementation does it literally) and rejected if it removes a Property, redefines one (name, supplying role, Mandatory, Propagate, or Default), or **adds a Property that is not optional** — spec §6.2 requires every added Property be optional. Channels are fixed by the first published version: never added, removed or redefined after (spec §6.2, §6.5). Anything else is a new contract and takes a new name (spec §7.7). The rejection says so and says why, but proposes no successor name: "this specification defines no relationship between Profiles, and none SHALL be inferred from their names."

**A consequence worth surfacing early** (spec §6.2 NOTE): a Property that proves ill-advised — a privacy or security liability among them — can never be removed from later versions of that name. The remedy is Deprecation plus publication under a new name. The editor warns at the moment a Property is first published, because that is the last moment it is cheap.

### 13.5 Deprecation and release

**Deprecation** is set by the author when a version should no longer be taken up. The version remains published in every other respect — immutable, resolvable, its Connections unaffected; what changes is that it is excluded from selection for new Connections (spec §8.6). There is no sunset window and no retirement: versions accumulate and none is deleted (spec §7.3). Deprecation is per version, not per name.

**Release** is available only while no version has ever been published, and releases the name (spec §7.3). A name with a published version is permanent.

## 14. Gates: what the Registry may refuse, and what the owner may

This split is a conformance question, not a preference. Spec §9.3: a conforming Registry "SHALL register any name that meets the requirements of §7.2 and §7.3… The grounds on which a Registry may refuse are those this specification states, and no others."

**Registry gates — the only grounds for refusal:**

| At | Gate | Source |
|---|---|---|
| Registration | Name has ≥ 2 segments | spec §7.2, §9.3 |
| Registration | Name is lowercase and well-formed | spec §7.2 |
| Registration | Prefix is allocated, and the owner's authorization for this name exists | spec §7.3, §9.3 |
| Registration | Name is not already registered | spec §6.2 (one name, one Profile), §7.3 |
| Registration | Prefix is not reserved or withheld | spec §7.1 + operator policy (§3.2) |
| Publication | Additivity against every prior version, where prior versions exist; Channels unchanged after the first | spec §6.2, §6.5 |
| Publication | Header carries every REQUIRED field; Name equals the registered name exactly | spec §6.6, §9.4 |
| Publication | At least one Property; Property and Channel names unique in one name space; each carries the required attributes | spec §6.4, §6.5, §9.4 |

**Owner gates — the organization's own publication process,** which the Registry executes on the owner's behalf and never on its own initiative: contract lint (§16), second-reviewer rules, internal naming conventions, architecture review. An owner configures these, and they apply to that owner's names only.

The operator retains one intervention, and it is not a content gate: a **steward hold** on an allocation (§7.2 `locked`), for disputes and legal orders. It suspends new registration under that Prefix. It cannot alter, unpublish, or refuse to serve anything already published — spec §9.3 forbids all three.

## 15. Authoring API

Authoring shares the resolution paths and separates from them by HTTP method, not by prefix. **The reference syntax is the URL syntax** — `cp:acme.meter.flow:2` is `/acme.meter.flow:2` — so there is exactly one URL per object, and a name or a version is addressed the same way whoever is asking and whatever they intend to do:

```
PUT    /<name>                    register the name → claims it, and nothing else; idempotent
DELETE /<name>                    release — only while no version has ever been published (§13.5)
POST   /<name>/publish            body: the document → checked, frozen as the next integer version,
                                  or refused with nothing retained   (?dry_run=true, §15.1)
POST   /<name>:<n>/deprecate
PATCH  /<name>:<n>/header         Owner and Website only (spec §6.6)
POST   /operator/allocations      the §9.2 operator act built so far: allocate a Top Level Prefix
GET    /profiles?q=…&prefix=…     search — the catalog (§19)
```

There is no route that reads or writes unpublished content, because the Registry holds none (§13.3): `/<name>:unpublished` answers the same 404 to every party.

The read/write split is therefore by method: `GET` is the resolution profile that every instance implements; every other verb belongs to the authoritative profile and exists only at `cp.cnscp.io` (§4.4). Caches need no path rules, since no cache stores a `PUT` or `POST`, and a local instance simply refuses non-`GET` at the root and returns the authoritative host's URL.

- Errors are structured (`{ code, message, gate, details }`) and distinguish **Registry refusals** (spec-grounded, §14) from **owner-policy refusals**, because the remedies differ: one means the request was invalid, the other that an internal review has not passed.
- Registration is idempotent on the name. An `Idempotency-Key` for the other writes is planned and not yet built; a retried publication is refused by the additivity and identity gates rather than duplicated.

### 15.1 Machine and agent authoring

Authoring is driven by programs and AI agents as much as by people, and the API is designed for that first — a UI is one client among several, not the primary surface. Concretely:

- **Structured, actionable rejections.** An agent must be able to *act* on a refusal without parsing prose. Every rejection names the gate, the offending element, and the rule: `{ code: "additivity.property_removed", gate: "additivity", property: "flow-rate", prior_version: 3 }`. A message a human reads is an additional field, never the payload.
- **Dry run everywhere.** `POST …/publish?dry_run=true` runs every gate on the document it carries and returns exactly what a real call would, changing nothing. An agent should be able to converge on a publishable document without ever risking an irreversible act, and the lint (§16) is available the same way. *Ruled 12 Sept 2026:* the rehearsal needs `draft:write`, not `publish` — the gate findings are not what the `publish` scope guards, the irreversible act is, and an agent holding `draft:write` alone must be able to converge and hand a publishable document to the person who holds `publish`. Only the literal `dry_run=true` is a rehearsal; any other value is refused (400) rather than guessed, because the alternative is an irreversible publication.
- **Machine-discoverable.** A small MCP server exposes the authoring verbs (nine tools: the lifecycle, `check_publishable`, and the one operator act) as a deliberately thin HTTP client of the same API every other client uses — no privileged path, every gate and audit write happening exactly once — so an assistant drives the Registry without hardcoding endpoints. Built first, because hand-authoring by an assistant was the Phase 0 publication path (§25). An OpenAPI description from the route schemas is still to come.
- **Idempotent and retry-safe**, since agents retry — registration is naturally idempotent on the name, a retried publication is refused by the gates rather than duplicated, and an `Idempotency-Key` for the remaining writes is planned (§15).
- **Quotas and rate limits** per credential, not per organization, so a runaway loop is contained to its own credential.

**The agent's working document is the agent's own.** It is mutable without restriction, not a contract, and the Registry never sees it until the agent submits it for publication (§13.4) — so an agent can generate, test, discard, and regenerate as often as the work requires, and nothing outside can have relied on any of it. That is exactly the property spec §6.3 gives the unpublished form, and it happens to be the property an autonomous author most needs: the MCP tools carry the document as a parameter of `check_publishable` and `publish`, and hold it nowhere else.

### 15.2 Irreversible acts and scopes

Part Two has exactly one irreversible act, and it is cheap to perform and impossible to undo:

| Act | Why it cannot be undone |
|---|---|
| **Publication** | The version is immutable and is never deleted; the name becomes permanent (spec §6.2, §6.3, §7.3). A bad contract, published, is a bad contract forever — the only remedies are Deprecation and a new name. |

*(Disclosure was the second until the 8 Sept revision took unpublished content out of the Registry; the `disclose` scope went with it — §24.5.)*

Credentials are therefore scoped separately: `draft:write` (registration, release, stewardship, and rehearsing a publication), `publish`, `deprecate`, and `operator` for the §9.2 plane, which no authoring credential carries by default. A machine author normally holds `draft:write` alone — it can do the whole of the preparatory work, including converging on a document that passes every gate, and none of the damage. **The intended working pattern with an assistant** (Anto, 12 Sept): the assistant's token is an `agent` credential with `draft:write` and the person as principal; publication and deprecation need the person's own token, presented by the person. The audit chain records both — the agent's preparatory acts under the person's name, and the irreversible act under the person directly. Beyond that, an owner's publication policy (§14) may require that publication by a `service` or `agent` identity carry a human approver, which is a natural use of the owner-gates mechanism and keeps the requirement out of the Registry's own refusal grounds (spec §9.3).

Deprecation is deliberately *not* on the irreversible list — it is reversible in practice, since re-publishing the same content as a new version is always available, and it is the safety valve when something published turns out to be wrong.

## 16. Contract lint (owner-side, advisory)

Runs on demand, and at publication when the owner's policy asks for it. Never a Registry refusal ground. Its results are structured like every other response (§15.1), which makes it the practical guardrail for machine authors: an agent lints, reads the findings, revises its document, and repeats — the permanence warning in particular matters most when properties are being generated rather than deliberated.

| Check | Rule |
|---|---|
| Header completeness | All REQUIRED fields present (spec §6.6) — this one *is* a Registry gate; listed because the editor surfaces it inline |
| Property naming | Purpose-named; flags direction prefixes (`in_`, `out_`, `server_`, `client_`, `tx`/`rx`, `send`/`recv`) — the supplying role is structural, so encoding it in a name is redundant and misleading |
| Propagate deliberate | Every Property's Propagate explicitly chosen; the editor requires a decision rather than defaulting. Prompts the spec §6.4 question: is this value state every counterpart may observe (broadcast), or meaningful to one at a time (addressed)? |
| Non-capture | No Header or Property text conditions enactment on a named Governor or Realm (spec §5.3), and no realm policy embedded (spec §6.7) — both are conformance requirements for a Profile (spec §9.4) |
| Additivity preview | Diffs the candidate document against every published version and reports what would be rejected, before the author publishes — this is what `?dry_run=true` already does at the gate |
| Permanence warning | Flags newly added Properties: once published under this name they can never be removed (spec §6.2 NOTE) |

There is deliberately no "mode" check: the specification defines no mode field, and the 8 Sept revision removed the direct-route concept altogether — everything a Connection carries passes through the Realm (spec Appendix B.2), so there is nothing for a marking to distinguish.

---

# Part Three — Resolution and Distribution

*Inside the specification, and the only part that becomes software other people deploy.*

## 17. What a Governor needs, and when

Spec §7.4 has a Governor resolve at three moments. The unit of work is a Profile version — never a declaration — which is what makes the read path cacheable and a local instance viable.

| Moment | Why it resolves | What Part Three must serve |
|---|---|---|
| **Declare** | Validate a declaration against the Profile (spec §8.4) | The version's Properties: which role supplies each, and whether required. If the declaration names no version, the set of published versions. |
| **Match** | Select among published versions (spec §8.6) | Which versions exist **and which are Deprecated** — deprecated versions are excluded from selection for new Connections. |
| **Bind** | The Connection is modeled from the Profile's content (spec §8.7) | Full version content. |

## 18. Immutable content, mutable status — the caching split

Spec §7.4 says a cached version "can never be stale in any way that affects a match." That is true of the **Properties**, which never change. It is not true of the whole document: the Header's `Status` is lifecycle state and changes after publication (spec §6.6), and Deprecation is precisely a post-publication change that *does* affect selection at Match.

So the served document cannot be cached as a unit. Part Three splits it:

- **Contract content** — Properties and the fixed Header fields. Immutable; cacheable indefinitely; `Cache-Control: public, max-age=31536000, immutable` on a versioned fetch.
- **Mutable state** — `Status` and the two stewardship fields. Delivered through the journal (§20), not re-fetched per resolution, so a local instance learns of a deprecation by following the feed rather than by expiring a cache. **On the wire they are overlaid onto the frozen document** (`part-three/present.ts`, 11 Sept): a versioned answer carries the current Status, Owner and Website in its Header — spec §9.3 says these three "may differ between answers" — while its ETag and `Content-Digest` remain the frozen content's, because the contract did not move. The bytes are replayed verbatim unless something has moved. The selection surface lists the current Owner and Website per version as well.

Get this wrong and a local instance quietly keeps selecting a version its author deprecated a year ago. Nothing turns on the stewardship fields going stale, but Status is load-bearing.

The `:unpublished` reference gets no cache promise of any kind — it is never resolved by the Registry (spec §7.2), and the 404 that says so is `no-store`. A Realm that binds an unpublished Profile "relies on the content it took in, which is what makes those Connections provisional" (spec §7.4) — content its author may re-issue at any time.

## 19. Resolution API

Canonical host: **`https://cp.cnscp.io`**, on the resolution profile of the host contract (§4.4). Names resolve at the root under the dot rule: a first path segment containing a dot is a Profile name, so console and API paths can never collide with one; versions use `:` while sub-resources use `/`.

```
GET /<name>                    → published versions; selection left to the caller
GET /<name>:<n>                → one published version — the citable, cacheable form
GET /<name>:unpublished        → 404, for every party: a reference the Registry never resolves (spec §7.2)
GET /<name>/registration       → { registered: true, since: <date>, versions: [...] }   (spec §7.3)
GET /<tlp>                     → the allocation page (§19.3)
GET /                          → the root index: every allocated Prefix, stable public facts only
GET /profiles/<name>           → compatibility alias (legacy SDKs; ARETE.md documents this path)
GET /profiles?q=&prefix=       → catalog and search only
GET /distribution/*            → snapshot, journal, status (§20)
```

Resolution is the root; `/profiles` is the catalog.

**Requirements:**

- **One name and version is one content commitment** (spec §9.3). Responses carry a strong ETag and a `Content-Digest` derived from `content_hash`, so independent parties can detect whether their copies agree. Two answers for one version agree on their *contract* — the document minus Status, Owner and Website (`contractHash`) — which is what `verify-journal --resolve` compares, since those three fields may legitimately differ between answers (§18).
- **Deprecation is surfaced additively** — extra keys, never a mutation of the version's Properties.
- **Answers are given without regard to the identity of the party asking** (spec §9.3) — with no exception, now that the Registry holds no unpublished content.
- Availability is realm-grade, and local instances (§20) are the answer to the cases where it isn't.

### 19.1 What a person gets

A browser sends `Accept: text/html`, so `https://cp.cnscp.io/acme.meter.flow` renders a page: the Header, both role groups with every Property and every attribute shown, the list of versions with their status, the registration date, and a link to the raw document. `…/acme.meter.flow:2` renders that version; `…:unpublished` renders the §7.2 answer — this reference is not the Registry's to resolve. A dotless single segment renders the allocation it denotes (spec §7.1) — `cp.cnscp.io/acme` shows who holds `cp:acme` and what is registered beneath it.

Three rules keep this safe:

- **The page never summarizes.** It is a presentation of the same document, not a digest of it. What ARETE.md warns about — rendered views losing key-presence flags — happens when a view decides some fields are uninteresting, so this one decides nothing.
- **The raw document is one click away and labelled as the contract.** The page cites the URL and media type that produced it.
- **HTML is optional for a local instance.** The resolution profile (§4.4) requires the machine representations; rendering is a courtesy, and a JSON-only instance is fully conforming.

Because a single dotless segment now renders an allocation, every reserved path is also a withheld Prefix (§3.2) — otherwise a Prefix named `console` would shadow the console.

### 19.2 Serializations and content negotiation

The 2026 specification's Profile shape (`Header` object; `Properties` grouped into `Provider` and `Consumer` arrays, each Property carrying `Name`, `Mandatory`, `Propagate`, `Description`, `Sample` and, since the 8 Sept revision, an optional contract-bearing `Default`; an optional `Channels` array) differs from the format `cp.padi.io` serves today (flat metadata; `versions[].properties[]` with role, requiredness, and propagation encoded by **key presence** — `"server":null` present means the Provider supplies it). The specification mandates no serialization (spec §2.2), so the Registry stores the model and serves both:

| Representation | Media type | When |
|---|---|---|
| Specification shape | `application/cp+json; profile=2026` | Default for machines; `Accept: */*` resolves here |
| Legacy shape | `application/json` | The `/profiles/…` alias, and by explicit negotiation. Lossless for Channel-free versions; a version declaring Channels answers `406` here rather than serve a changed contract (§24.5) |
| Human page | `text/html` | Browsers (§19.1) |

`Vary: Accept` on every resolution response, and the cache key includes it.

**The deployed encoding, measured.** All 70 records were parsed on 31 August 2026 and the key-presence scheme is sharper than the paragraph above conveys:

| Property key | Present | Absent | Value when present | Means |
|---|---|---|---|---|
| `server` | 186 | 117 | **always `null`** | The Provider supplies it |
| `required` | 171 | 132 | **always `null`** | Mandatory |
| `propagate` | 278 | 25 | **always `null`** | Propagate |
| `name` | 303 | 0 | the string | — |
| `description` | 303 | 0 | the string | — |

Three things follow, and each one is a trap for a careless reader:

1. **Presence is the entire signal; the value carries none of it.** Every one of the 537 set flags in the corpus is `null`. `if (p.server)` is false for all 186 provider flags, and any transform that strips nulls — a JSON cleaner, a lenient ORM, a summarizing view — inverts all three flags at once. ARETE.md's warning about summarized views losing key-presence flags is this, exactly.
2. **No property carries a `client` key anywhere in the corpus.** The role is one key's presence, not a choice between two: absent `server` means Consumer.
3. **`server` at the top level is a capability title, not a flag** — the same key name meaning something entirely different one level down.

**And the legacy format has no version identifiers at all.** A version object carries only `properties`: no number, no status, no date. An importer therefore assigns versions by array position, which is consistent with spec §6.2 making assignment the Registry's job rather than the author's. Sixty-six records hold one version, two hold two, and two carry no `versions` key at all.

**No deployed record is a conforming Profile, and Phase 0 must decide what to do about that.** Spec §6.6 makes all ten Header fields REQUIRED and §9.4 makes carrying them a conformance condition. Measured across the corpus:

| §6.6 field | Legacy source | Records that can fill it |
|---|---|---|
| Name | `name` | 70 |
| Title | `title` | 69 |
| Owner | `company` | 66 |
| Website | `website` | 56 |
| Provider | top-level `server` | 55 |
| Consumer | top-level `client` | 54 |
| Description | `comment` | 51 |
| **Version** | *none* | **0** — the legacy format has no version identifiers |
| **Pub Date** | *none* | **0** — `created` is registration, not publication |
| **Status** | *none* | **0** — `approved` and `active` are null in all 70 |

Thirty-eight records can fill all six *mappable* fields; none can fill all ten. And **no Property carries a Sample** — 0 of 303 — an attribute spec §6.4 lists but takes no view of, so its absence is a formatting matter rather than a conformance failure (Q11). Property names are unique across both roles in every version, so that condition already holds.

Three of the four Header gaps have defensible answers: `Version` by array position (spec §6.2 makes assignment the Registry's job), `Status` by import policy, `Pub Date` from `created` or `modified` with the imprecision recorded. The remaining one — a missing `Owner`, `Description` or `Provider` title — cannot be filled without inventing contract content, and publication freezes content immutably and forever (§12.2). **The Registry must not author what it imports.** See §25 Q11.

Spec §6.2 offers a hint at the intended path: the unpublished form is unnumbered, and Version and Pub Date are assigned at publication (spec §6.6). Incomplete material is what the Unpublished state is *for* (spec §6.3) — but the Registry holds and answers for published versions only (spec §7.3), so importing the records as unpublished would leave all 70 unresolvable, which defeats Phase 0's purpose.

**Byte-identical re-serialization is impossible from the model, and should not be attempted.** The corpus carries 13 distinct top-level key orders and 23 distinct property key orders — the same fields written in different sequences by whatever wrote them across five years. A semantic model can reproduce one order, not thirteen. This is precisely why §12.2 stores `served_bytes` verbatim: spec §9.3's guarantee that one name and version is never answered with differing content comes from replaying stored bytes, not from a canonical serializer. The round-trip goldens (§23 priority 1) therefore assert *semantic* fidelity — presence for presence, property by property — and byte fidelity is a separate property that the storage column, not the mapper, provides.

### 19.3 The allocation page

`cp.cnscp.io/acme` — a single dotless segment — is the reference `cp:acme`, which denotes an allocation (spec §7.1). It renders the holder's page in HTML and returns the same facts as data under `Accept: application/json`, which makes it the natural discovery endpoint for "what does this organization publish?"

It carries:

- **Who holds it, and since when**, with the verification level recorded at allocation (§8.1). Note this is the *Prefix* holder, which need not be the `Owner` named in any given Profile's Header — spec §6.6 lets an owner make someone else responsible for a Profile beneath its Prefix.
- **An index of every registered name** beneath the Prefix, each with its registration date, its published versions and their status, and whether it has none. Spec §7.3 makes this public explicitly: "the existence of a claim is public even while its content is not, so a name long registered but never published can be seen for what it is." Such a name shows as *Unpublished*; there is no content to show, because the Registry holds none.
- **The owner's own pointer** — a plain-text description and a URL, owner-supplied and documentary, participating in nothing. Text and link only; no owner-supplied markup.
- A link to `/profiles?prefix=acme` for the full, paged catalog, so the page and the catalog never define listing semantics twice.

Two things it deliberately does not do:

**In-flight governance stays off the page.** Holder and verification level are stable public facts. A lock, a redemption clock, or a dispute under way is not: it is transient, potentially prejudicial, and no business of anyone resolving a name — published versions are unaffected by all of it (§4.1). Dispute *outcomes* are published, as historical fact, through the transparency record (§25 Q4).

**A deep unregistered prefix is not an index.** `GET /acme.meter` when only `acme.meter.flow` is registered returns 404 in the machine representations, because `acme.meter` is not a registered name and the specification places no structure below a Prefix (spec §7.1). The HTML page may offer "no such Profile — 3 names begin `acme.meter.`" as a search affordance, clearly framed as a search over strings. The distinction matters: a helpful index that behaved like a node would quietly reintroduce the name hierarchy the specification does not have.

The mapping is mechanical and lossless both ways: `server` key present ⇔ Property in the `Provider` array; `required` present ⇔ `Mandatory: yes`; `propagate` present ⇔ `Propagate: yes`; `versions[]` index ⇔ integer version. Golden round-trip tests run over every imported document in both directions, because a flag lost in translation is a changed contract.

## 20. Distribution and local instances

Spec §7.4 requires that "a conforming Governor SHALL be able to operate from a local Registry instance," reasoning that a Realm whose resolution depends on reaching a remote instance "stops governing when the network does — and, with a single Registry, depends on the continued good behavior of a single institution." That makes this core, not a later nicety.

For an operator standing up `cp.acme.com`:

1. **Bootstrap.** `GET https://cp.cnscp.io/distribution/snapshot` → every published version with its content hash, plus the audit-chain head at that moment.
2. **Follow the journal.** `GET /distribution/journal?since=<cursor>` → append-only, hash-chained: version published, version deprecated, stewardship field changed, name registered or released, Prefix allocated. Cursor-based and resumable. This is also how mutable status reaches instances (§18).
3. **Verify, don't trust.** Check each document against its content hash and each batch against the chain; the operator publishes a signed anchor of the chain head periodically. An instance cannot fabricate or alter a Profile without breaking the chain, and its clients can check.
4. **Serve.** The same resolution API at its own host, byte-identical. Plus `GET /distribution/status` → `{ upstream, cursor, lag_seconds, anchor_verified }`.
5. **Never write.** Instances are resolution-only; the Part One and Part Two APIs exist solely at the authoritative store. Many instances, one namespace (spec §7.3).

Unpublished content never appears in the feed, for the simple reason that the authoritative store holds none (spec §7.3); an instance answers `:unpublished` exactly as the authoritative host does.

### 20.1 The feed, as built (Phase 1, 11 September 2026)

Built on the resolution profile, so the authoritative host and every instance serve the same three routes; §21 makes the shapes below additive-only from here on. `journal_format: 1`.

**`GET /distribution/snapshot`** — one consistent read (a `REPEATABLE READ` transaction): the chain head at that instant as `head: { seq, event_hash }`, which is also the cursor to follow from; every allocation as the §19.3 stable public facts (`id`, `tlp`, `holder`, `org_id`, `grandfathered`, `class`, `allocated_at`) — never `status`, never `pending_claimant`; every registered name (`id`, `name`, `registered_at`, `imported_from`, `allocation_id`); every published version with its document (`id`, `name`, `version`, `status`, `published_at`, `content_hash`, `owner`, `website`, `grandfathered`, `pub_date_approximate`, `missing_header_fields`, `document`). Identifiers are the authoritative store's own, so a journal entry that names a version by id lands on the same row everywhere.

**`GET /distribution/journal?since=<seq>&limit=<n>`** — the audit chain of §4.3, projected. Every event with `seq > since` appears, in order, so the chain is contiguous and an instance can check every link. Two entry shapes:

- **Public acts** — `profile.register`, `profile.publish`, `profile.deprecate`, `profile.stewardship`, `profile.discard`, `allocation.create` — carry **the exact preimage of `event_hash`**: `at` (formatted as the chain function formats it), `actor`, `actor_kind`, `principal`, `org_id`, `action`, `subject_type`, `subject_id`, `before_hash`, `after_hash`, `rationale`, `request_id`, `prev_event_hash`, `event_hash`. A verifier recomputes the hash from these and needs nothing else. *Ruled 11 Sept: `principal` and `rationale` are published.* §4.3 already said "who published this" ends in a person and §15.1 that rationale is published where the act is; a feed that withheld them could not be verified against the log, and a chain nobody outside can verify is decoration.
- **Everything else** (`organization.create`, `member.add`, the bootstrap's `allocation.grandfather` rulings — whose payload names the pending claimants §19.3 keeps off the page — and any act added later) appears **redacted**: `seq`, `action`, `prev_event_hash`, `event_hash`, `public: false`. The link is checkable; the content is not published.

Alongside the preimage, a public entry carries what an instance needs to apply it. `subject` is the `after` payload the act hashed — from `audit_event.after_payload`, stored by migration 7 beside its hash for every event written from then on (`subject_source: stored`). For earlier registrations, publications and deprecations it is **rebuilt from the immutable row in the shape `record()` used at the time** (`subject_source: reconstructed`), so `after_hash` stays checkable back to genesis; an early stewardship act has no subject, because the row it changed may have changed again. `document` (on `profile.publish`) is the frozen version, and `contentHash(document)` must equal `subject.content_hash`. Courtesy fields — `ref: { name, version }`, `registered_at`, `published_at`, `status`, `owner`, `website`, `allocation: { tlp, holder, grandfathered, class }` — are read from the current rows and are **not** covered by the hash; from migration 7 on, `registered_at` and `published_at` are inside the hashed payload as well. What the chain proves, therefore: which acts happened, in what order, by whom, and — for every publication — exactly what content. What it does not prove for pre-migration events: the timestamps the courtesy fields report.

Paging: `limit` 1–1000 (default 200); the response carries `next` (the last `seq` served) and `more`, and `head` (the chain head now) only on the page that reached it — so a full page has no moving part and is served `immutable`, while the last page is `no-cache`. An instance serves the journal from its own verified copy, from its bootstrap point onward; asked for earlier, it answers `416` with `earliest_seq` and the authoritative host's URL.

**`GET /distribution/status`** — `{ role: "authoritative" | "instance", journal_format, head, upstream, cursor, lag_seconds, last_sync_at, anchor }`. The signed anchor of §4.3 is **not yet published** (`anchor: null`); an instance therefore verifies content hashes and chain integrity, and reports `anchor_verified: null`. Publishing the anchor is a key-management decision for the operator and is listed in §25.

**The instance** (`npm run instance`, entrypoint `src/instance-server.ts`) is the resolution server plus a follower. On an empty database it bootstraps from the snapshot in one transaction and records `head` as its cursor; thereafter it polls the journal, and for each page checks that the first entry's `prev_event_hash` is the cursor it holds, recomputes every `event_hash`, verifies every `document` against `subject.content_hash`, applies the public acts to its own `profile`, `profile_version`, `allocation` and `organization` rows under the authoritative identifiers, keeps a verbatim copy of every entry in `journal_entry`, and advances `instance_state` — all in one transaction per page, so a break in the chain leaves the instance exactly where it was, with the break reported on `/distribution/status`. It never writes an `audit_event` of its own: it is not a writer. Any non-`GET` on an instance answers `405` with the authoritative host's URL (§4.4). `npm run verify-journal -- <host> [--resolve]` is the same verifier as a standalone tool, for a party that runs no instance: it walks the chain, and with `--resolve` fetches every published version from the host and checks that what is *served* hashes to what the act *recorded* — spec §9.3's "independent parties can detect whether copies agree", performed by one. Proven in test against the real corpus: after bootstrap and after one of every public act, an instance answers every resolution URL byte-for-byte as the authoritative host does, `Content-Digest` included.

## 21. Back-compatibility discipline

Part Three is the only part deployed by people who are not the operator, on schedules the operator does not control — inside customer Realms, in regions, on air-gapped sites. It follows that:

- The **resolution profile** (§4.4) is the versioned artifact — the wire contract and the journal format — and it changes additively only. An instance built today must keep working against the feed in five years, or Realms lose the durability spec §7.4 exists to give them.
- New fields are additive and ignorable; no field ever changes meaning.
- The compatibility alias `/profiles/<name>` is permanent, not transitional.
- A breaking change to the feed would require a parallel endpoint and a long overlap — treat it as a last resort, and design the journal to make it unnecessary.

---

# Closing

## 22. Conformance checklist (spec §9.3)

Acceptance criteria for Parts Two and Three.

| spec §9.3 requirement | Where met |
|---|---|
| SHALL NOT register a name under a Prefix without its owner's authorization | §9.3 `authorizes()`; §14 registration gates |
| SHALL NOT register a name of fewer than two segments | §3.1 grammar; §14 |
| Answers that a name is registered, and since when | §12.1 `registered_at`; `GET /<name>/registration` |
| SHALL NOT hold, serve, or answer for the content of an unpublished Profile; SHALL answer that a name is registered and since when | §12.1 has no content columns (migration 6); `:unpublished` never resolves (§13.3, §19); `GET /<name>/registration` |
| SHALL NOT delete or alter a published version | §12.2 triggers; no operator endpoint exists (§9.2) |
| Permits Header change only for lifecycle and stewardship fields | §12.2 columns; `PATCH …/header` restricted to Owner and Website; the answer carries the current values (§18 overlay) |
| Serves without regard to the identity of the party presenting a name | §19 |
| SHALL register any name meeting spec §7.2 and §7.3; refuses only on stated grounds | §14 — owner policy is not a Registry ground |
| Same name and version never answered with differing content | §12.2 `served_bytes` + `content_hash` |
| Answers such that independent parties can detect whether copies agree | `Content-Digest` + signed anchor (§4.3, §19, §20) |

Two further requirements land indirectly: a conforming Profile must bear "a registered name of two or more segments, lowercase, under an allocated Top Level Prefix" (spec §9.4), which the registration gates guarantee; and a conforming Governor must be able to operate from a local instance (spec §7.4), which §20 exists to make possible.

## 23. Implementation sketch

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node 22 LTS + TypeScript, ESM | Matches the SDK's primary binding |
| HTTP | Fastify | Schema-first routes double as API documentation; clean isolation between the parts |
| Persistence | PostgreSQL 16; `jsonb` model + `bytea` served bytes | Relational integrity for the ownership graph; verbatim bytes for the one-content-commitment rule |
| Migrations | node-pg-migrate | Immutability triggers live in migrations and are reviewed like code |
| AuthN | Static scoped bearer tokens from the environment in Phases 0–1; OIDC via `openid-client` and credential issuance in Phase 2 | One credential per actor, scopes per §15.2; the token never enters a cache key (§4.4) |
| AuthZ | One pure module implementing §9.3 `authorizes()`, plus credential scopes (§15.2) | The whole ownership chain in one testable place, and the seam |
| API description | OpenAPI from Fastify route schemas; a thin MCP server over the authoring verbs | Machine and agent authoring is a first-class path (§15.1), not an afterthought |
| Jobs | `pg-boss` | Redemption timers, renewal warnings, anchor publication, journal compaction |
| Caching | ETag + `Content-Digest`, CDN in front of resolution | Immutability makes versioned content infinitely cacheable (§18) |
| Audit | Same-transaction append, SHA-256 chain, periodic signed anchor | Tamper-evidence without ceremony |

Deployment: one codebase, four entrypoints as built — `allocation` (`tlp.`, the seam), `authoritative` (authoring + resolution + distribution: `cp.cnscp.io`, the only writer), `resolution` (resolution + distribution, for read replicas), and `instance` (resolution + the §20 follower: `cp.<organization>`). Resolution and distribution scale independently; allocation and authoring are single-instance-friendly at expected volume.

**Testing priorities:**

1. **Serialization round-trip goldens** — every imported document, both directions, property by property. A lost flag is a changed contract.
2. **Additivity property tests** — including added-Properties-must-be-optional.
3. **Immutability at the database layer** — UPDATE and DELETE of a published version must fail even on a superuser path; only `status` forward and the two stewardship fields may move.
4. **Authorization table tests** — the full chain, including the negatives: publishing without authorization, registering a one-segment name, registering under a reserved Prefix.
5. **Nothing unpublished is ever held** — a refused publication retains nothing; `:unpublished` is never resolved for any party, credential or not; the schema has nowhere to put unpublished content.
6. **Seam isolation** — Part Two serves reads and edits with Part One unavailable; governance state never appears in a resolution response.
7. **Scope containment** — a `draft:write` credential cannot publish or deprecate, nor perform an operator act, under any endpoint or parameter combination; and `dry_run=true` provably writes nothing.
8. **Distribution** — the TypeScript chain function agrees with the database trigger on every real event; an instance answers byte-identically after bootstrap and after one of every public act; a tampered, gapped, or document-swapped page never moves the cursor.

## 24. What changed when the 2026 specification landed (v0.2 → v0.3)

*Historical: this table records the v0.3 design in its own vocabulary. "Draft" and `:draft` here are what the 26 Aug anchor called the unpublished form; §24.5 records the rename and the withdrawal of Registry-held drafts.*

| v0.2 | Now | Reason |
|---|---|---|
| A `sandbox` Top Level Prefix with per-user subtrees, mutable contents, expiry clocks, anti-freeloading rules | **Removed entirely** | The Draft (spec §6.2) does this job under the Profile's own name, so nothing is renamed at publication. Spec §7.3's disclosure rule handles the freeloading concern better than expiry clocks did. |
| `unpublished → published`; the draft was a pre-state consumed at publication | **One Draft per name, permanent**, alongside N versions | Spec §6.2: publication does not consume the Draft. |
| `retired` state; 180-day sunset windows | **Removed** | Three states only — Draft, Published, Deprecated. Versions accumulate and none is deleted (spec §7.3). |
| Status on the profile record | **Status per version** | Spec §6.4 puts Status in the version Header. |
| Nesting rule: `iso.std1.std2` required `iso.std1`; `parent_id`; subtree delegation as a tree | **String-prefix scopes; no nesting enforced** | Spec §7.1 places "no requirement on the shape or depth of a name below its Prefix"; refusing on that ground would breach spec §9.3. |
| Lint and operator review as blocking publication gates | **Owner-side policy**, executed on the owner's behalf | Spec §9.3: refuse only on grounds the specification states. |
| Blanket immutability trigger on published rows | **Owner and Website mutable** post-publication | Spec §6.4 stewardship fields. |
| No version in the reference grammar | `cp:name:2` and `cp:name:draft` | Spec §7.2 reference forms; spec §6.2 integer versions. |
| Bare TLP simply invalid | `cp:acme` **denotes the allocation** | Spec §7.1: every reference is an allocation or a Profile. |
| `cp:` described as a scheme | A **marker** | Spec §7.2 rejects the URI framing explicitly. |
| Reserved list without `example` | `example` and `test` are spec-reserved | Spec §7.1, following RFC 2606. |
| Additivity permitted added required Properties | Added Properties **must be optional** | Spec §6.2. |
| "Mode 1 / Mode 2 declared" lint | **Removed** | No mode field exists; spec §6.6 NOTE says the difference is unmarked by design. |
| Single serialization, key-presence flags | **Two representations**, mapped losslessly | The 2026 shape differs from the deployed one; spec §2.2 mandates no serialization. |
| Replication late in the roadmap | **Distribution is Part Three, core** | Spec §7.4 requires Governors be able to operate from a local instance. |
| Framed as "the authority for the CP namespace" | **The allocation function plus a conforming Registry** | Spec §7.1 and §7.5. |

## 24.5 What changed when the 8 September revision landed (v0.5 → v0.6)

| v0.5 (26 Aug anchor) | Now (8 Sept anchor) | Reason |
|---|---|---|
| The **Draft**: stored by the Registry, with `draft_content`, three disclosure states, and an irreversible trapdoor to `public` | **Unpublished**, and the Registry **SHALL NOT hold, serve, or answer for it** (spec §6.3, §7.3, §9.3). Content lives with the author; a Realm that binds it publishes what it took in. Columns dropped (migration 6); disclosure machinery withdrawn | Spec §7.3: "Of an unpublished name it holds the entry alone" |
| `POST /publish` froze the stored Draft | **Publication carries its content**: the document travels in the request body, is checked, and is frozen or refused with nothing retained | Spec §7.3: "Publication is the act by which a Profile's content enters the Registry" |
| Reference token `:draft`; `GET /name:draft` served a public Draft | Token **`:unpublished`**, and the Registry **never resolves it** — only a Realm holding conveyed content can | Spec §7.2, §7.4 |
| Status `Draft · Published · Deprecated` | **`Unpublished · Published · Deprecated`** | Spec §6.3 |
| Properties: Name, Mandatory, Propagate, Description, Sample | Adds **Default** (optional, contract-bearing: redefining it breaks additivity) | Spec §6.2, §6.4 |
| No Channels | **Channels** (Name, Mode `stream·message·datagram`, Protocol, role mappings, Description), sharing one name space with Properties, **fixed by the first published version** — never added, removed, or redefined after | Spec §6.5, §6.2 |
| "any number of Properties" | **At least one Property**, whether or not Channels are declared | Spec §6.4, §9.4 |
| Additivity vs the highest prior version | Measured **against every prior published version** (implemented literally) | Spec §6.2 |
| Scopes `draft:write · publish · deprecate · disclose` | **`draft:write · publish · deprecate`** — the disclosure act left the Registry | Spec §7.3 |
| Legacy serialization lossless for everything | Lossless for Channel-free versions; a **Channel-bearing version refuses the legacy shape (406)** rather than serve a changed contract | This design's ruling, 9 Sept |
| Authorization required for registration and publication | Required for **every act on a name** — registration, publication, Deprecation, stewardship, release (already implemented; now ratified) | Spec §7.3, §9.3 |
| — | A version's **content** formally excludes Status/Owner/Website, which "may differ between answers" — normative backing for the §18 caching split | Spec §6.2, §9.3 |

Section renumbering in the spec: Header §6.4→§6.6, worked example §6.6→§6.8 (now two examples — `example.light` gains a Default; `example.camera` demonstrates Channels), lifecycle split out as §6.3, Channels new at §6.5, Properties §6.3→§6.4, Realm deferral §6.5→§6.7. v0.7 remapped every citation in this document to the new numbers, except inside §24, which is historical.

## 25. Roadmap

| Phase | Delivers |
|---|---|
| **0 — Store as canon** *(next few weeks)* | Import the 70 records from `cp.padi.io` under the §10.2 rulings; stand up Part Three resolution at `cp.cnscp.io` in both representations; minimal Part Two authoring against the Part One spine (§10.3) — API-first and assistant-drivable from the start (§15.1), since hand-authoring by an assistant is the intended publication path in this phase — so Arete gateway and widget work is unblocked. Two disciplines from day one: published content is write-once, and every write is audited. Git-backed storage is a credible v0 — the repo is the audit chain and later becomes the seed data. |
| **1 — Conforming Registry** *(opened 11 Sept 2026)* | Parts Two and Three in full against the §22 checklist: registration with authorization, ~~Draft with the disclosure trapdoor~~ *(withdrawn by the 8 Sept revision, §24.5)*, publication with integer versions and additivity, per-version deprecation, **distribution feed and local instances (§20.1 — built first)**, audit chain. Still open in this phase: the signed anchor, the §16 lint, a second real credential, and Q10. |
| **2 — Allocation** | Part One for real: organization verification, Prefix application and allocation, renewal and redemption, authorization scopes, voluntary transfers, management UI. The stub retires. |
| **3 — Trust and disputes** | Dispute workflow, forced transfers, restricted-Prefix review, verification levels, published transparency record of allocation decisions. |
| **4 — Ecosystem** | CI publishing tokens and a GitHub Action, owner-configurable publication policy, lint as a standalone tool authors can run before registering. |

### Open questions

1. ~~**Bootstrapping the existing namespace — blocks Phase 0.**~~ **Settled in v0.5; see §10.2.** The inventory (§10.1) found 70 records across 18 Prefixes. `test.abc` moves to `padi.test.abc`; `proto` is withheld with its sub-names imported and its spec-forbidden bare record dropped; `acme` and `xyz` are withheld as documentary; the seven Prefixes with real external claimants are operator-held and released on verification. Phase 0 is unblocked.
2. ~~**Which representation is canonical at `cp.cnscp.io`.**~~ **Settled 31 Aug 2026: the 2026 specification shape is the default.** `Accept: */*` resolves to `application/cp+json; profile=2026`, as §19.2 proposed; the deployed shape remains available at the `/profiles/` alias and by explicit negotiation. The deployed fleet migrates or negotiates explicitly. The storage layer was never affected — §19.2 stores the model and serves both, so this decided only content negotiation.
3. **Fees.** Annual terms imply a fee or some other anti-squatting friction. Out of scope here; the renewal and redemption machinery is fee-model-agnostic.
4. **Who reviews the reviewers.** Steward appointment and the two-steward rule are asserted, not designed. A charter is needed before Phase 3 — and it matters more than it looks, since the specification makes the Registry a single institution whose continued good behavior spec §7.4 explicitly declines to rely on.
5. **The registrar role stays vacant.** No party registers Prefixes on behalf of others. The part split and organization model leave room to accredit one later without redesign.
6. **Delegation chains.** Standards bodies subdivide more than twice (`ashrae` → committee → working group). v1 forbids re-delegation; the pattern may force it early.
7. **Two rules in §5 and §8.3 have no mechanism — surfaced while building the spine.** (a) §5 says membership "is itself authorization to act under the Prefix in Part Two, **unless the owner has narrowed it with scopes**," but §6.4's `authorization_record` grants scope to *another organization* and has no form that narrows a member of the holder. As written, membership is unconditional and the narrowing clause is unimplementable. Either §6.4 gains an intra-organization form, or §5 drops the clause. (b) §8.3 says scopes "are not re-delegable at v1," but nothing records *which organization granted* a record, so a grantee granting onward cannot be distinguished from the holder doing so. Enforcing it needs a `granted_by_org` column. Both are small; both are load-bearing the moment a standards body arrives, which is also what Q6 is about.
8. **Allocation term expiry is recorded and unenforced.** `allocation.expires_at` exists (§6.3) and nothing reads it: the redemption transition of §7.2 is what moves `status`, and that is Phase 2 work. Until then an allocation whose term lapsed years ago still authorizes writes. Harmless while the operator holds nearly everything; a real gap the moment §8.2 renewal is announced to holders.
9. **§8.1 has one verification method, and it excludes real claimants.** Domain control via DNS TXT or `/.well-known/` proves control of a *web identity*, which two of the seven grandfathered claimants (`ibb`, `skycentrics`) simply do not have — their recorded websites are Google Docs. A second method is needed before Phase 2, and the obvious candidate is an operator attestation: a steward records direct contact with the claimant as evidence, with rationale, in place of an automated challenge. That trades a machine-checkable proof for a human one, so it needs the two-steward discipline of §5 and a published record — which is also why it interacts with Q4, who reviews the reviewers.
10. **The 2026 revision is in draft, and the public repository still carries the 2022 one.** *Partly addressed: the anchor is now pinned by hash in this document's header, and `registry/scripts/verify-spec.mjs` checks it, so drift in the working copy is detected rather than silent. What remains is a transition, not an oversight — the 2026 revision is a live draft and publishing it is a decision about the standards process, not a chore.* Two things stay true meanwhile. **First, §22's conformance checklist cannot be checked by anyone outside the editors.** Its rows cite sections that resolve to nothing in the only public document, so "a conforming Registry" is currently a claim its authors alone can verify — while spec §9.6 is titled "How conformance is observed" and §7.4 requires third parties be able to run a local instance. Those implementers are third parties by design. **Second, the public draft actively misleads rather than merely lagging**: someone building from it emits `"Status": "Active"`, puts `"Source": "provider"` on each Property, and has no Propagate attribute — an incompatible contract. This is not hypothetical; `spec2026.ts` refuses `"Status": "Active"` precisely so a 2022-shaped document cannot be imported as though it carried 2026 lifecycle state, and there is a test for it. A one-line note on the public readme saying `main` is superseded and a revision is in progress would cost nothing and prevent that. For the record, `github.com/CNSCP/specification` on `main` carries the December 2022 draft — different section numbering (§2.3 Header, §2.4 Properties), different Status values (`Testing`/`Active`/`Deprecated`), Properties as repeated `"Property"` keys with `"Source": provider|consumer`, and **no Propagate attribute at all**. This document is written against the 2026 revision (§1–§10, assembled 8 September 2026), which exists only as a working copy. Until the normative anchor is public, no independent party can check this design against the specification it claims to conform to — and the conformance checklist in §22 cites sections a reader cannot look up. Publishing the revision, or at least pinning the exact copy this design was written against, is a prerequisite for the §22 checklist to mean anything to anyone but its authors. *(Noted while building: the 2022 draft's worked example in its §2.4.1 is `cp:xyz.ics:2`, with the same Owner and `www.example.com` website as the live `xyz.ics` record, and its §3.3–§3.4 examples use `test.abc` — so both Prefixes withheld under §10.2 are the specification's own sample data, which is a stronger reason for those rulings than the ones recorded there.)*
11. ~~**What Phase 0 imports, given that none of it conforms.**~~ **Settled 31 Aug 2026; see §10.4.** Real Connections bind against the deployed records, so they must keep resolving through the import. They are imported as published versions, marked grandfathered, with their §9.4 shortfalls recorded and published rather than filled. Nothing is fabricated. The `Sample` question is settled with it: spec §6.4's "this specification takes no view of them" makes an absent Sample a formatting matter, not a conformance failure — so all 303 deployed Properties clear that bar.
12. **The signed anchor is not yet published.** §4.3 has the operator periodically sign the chain head and §20 has instances verify against it; as built, `/distribution/status` reports `anchor: null` and an instance verifies content hashes and chain integrity only. What the anchor adds is protection against an authoritative host that serves *different* consistent chains to different parties — a fork — which hashes alone cannot detect. Needs a signing key held outside the cluster, a publication place (the `.well-known` path is reserved for it), and a rotation story. Small; deliberately not improvised.

---

*Design document for the Connection Profile Registry. The [CNS/CP specification](https://github.com/CNSCP/specification) is authoritative throughout; where this document conflicts with it, this document is wrong. [ARETE.md](https://raw.githubusercontent.com/project-arete/sdk/main/ARETE.md) remains authoritative for SDK-facing conventions.*
