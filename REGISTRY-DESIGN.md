# Connection Profile Registry — System Design

**Status:** Draft v0.17 · 21 September 2026
**Normative anchor:** the CNS/CP specification, **2026 revision**, **published 16 September 2026** at [github.com/CNSCP/specification](https://github.com/CNSCP/specification) — §1–§10 with Appendices A–C, editors Toby Considine and Anto Budiardjo. Where this document and the specification differ, the specification wins and this document is wrong.

> **The anchor is pinned, and now anyone can check the pin.** This design is written against one identifiable artifact:
>
> ```
> cnscp-2026-specification.md
> SHA-256  072d443584c28b383c228a002ad10cc7e2f5d9bcab40b80d182d385062be6c0e
> 136,899 bytes · published 16 September 2026
> ```
>
> Those bytes are served at [raw.githubusercontent.com/CNSCP/specification/main/cnscp-2026-specification.md](https://raw.githubusercontent.com/CNSCP/specification/main/cnscp-2026-specification.md), so a reader can fetch the file, hash it, and confirm it is the document every `spec §n` citation below means — which until 16 September no one outside the editors could do (§25 Q10, now settled). `npm run verify-spec` does the same check locally, against a checkout beside this repository.
>
> Without the hash, "the 2026 revision" is a description rather than an identifier: the text moves, the citations quietly stop matching, and nothing detects the drift. This is the same argument §4.3 makes for the audit anchor, applied one level up — and publication does not retire it, because a published draft still revises.
>
> **What publication changed in the text: nothing normative.** The pin moved from the 8 September working copy (`442043a7…8a712c8`, 134,887 bytes) to the published revision, and the two were compared rather than assumed equal: the same 108 normative sentences, and every §1–§10 subsection heading identical, so no citation in this document moved. What was added is front matter — provenance, requirements language, terminology, clause status, reading order — and Appendix C, the editors' open issues. The 26 August predecessor (`bbeec3f7…22be09b`) is archived beside the working copy; v0.5 of this document was written against it and §24.5 records what moved then.
>
> **The 2022 draft is no longer what the repository serves.** It is kept as history under [`2022/`](https://github.com/CNSCP/specification/tree/main/2022), and `main` now carries the 2026 revision. Building from the repository therefore no longer produces an incompatible contract — see §25 Q10 for what that was and why it mattered.

**Companion reading:** [ARETE.md](https://raw.githubusercontent.com/project-arete/sdk/main/ARETE.md) (SDK conventions) · [CNS/CP specification repo](https://github.com/CNSCP/specification) *(the 2026 revision, published)* · [current profiles server](https://cp.padi.io)

**Reference convention:** *spec §7.3* cites the CNS/CP specification. A bare *§12* cites a section of this document.

> **On this revision.** v0.3 was a single flow. v0.4 divided the work into the three parts it naturally has — allocation, authoring, and resolution — because they differ in who runs them, who uses them, how fast they change, and whether the specification constrains them at all. §4 defines the parts and the seams between them; §24 records what changed from v0.2 when the 2026 specification landed.
>
> **v0.17 gives the unpublished form a host (17–21 September).** §20.3: an organization's workspace beside its local Registry instance — the same image, two settings, run inside a security boundary or in public, `cp.padi.io` first — holding the unpublished forms of the names the organization holds and of `test.*`, open to read, marked on every answer, one credential per surface, never in the feed, with the spec §5.3 non-capture argument written out. The Registry surface of a host running one stays byte-identical to canon in every machine representation. §4.4, §13.3, §20 and §22 are qualified accordingly; §3.2 withholds `workspace`; §25 gains Q14 (the credential's second form). Built and tested 21 September, with forwarding (`FORWARD_WRITES`, a pipe that holds no credential of its own and refuses nothing), the MCP server's `get_unpublished` / `save_unpublished`, and the private and public worked deployments in `deploy/INSTANCE.md`.
>
> **v0.16 repins the anchor to the published specification (16 September).** The 2026 revision is public: `main` at github.com/CNSCP/specification carries it, the 2022 draft moves to `2022/` as history, and this design's anchor moves from the 8 September working copy to the published bytes (`072d4435…be6c0e`, 136,899). The two were compared rather than assumed equal — 108 normative sentences in both, every §1–§10 subsection heading identical, so no citation moved; what was added is front matter and Appendix C. §25 Q10 is settled, and with it the §22 checklist becomes checkable by someone other than its authors. The hash pin stays: a published working draft still revises.
>
> **v0.15 (14 September, same day): what is served is what was signed.** The first published anchor verified on arrival and failed as served — `at` lost its milliseconds to a `timestamptz` round trip. Migration 13 stores the signed `at` verbatim, `anchor publish` verifies the stored form before committing, and the test now goes through the database and the route rather than checking the cryptography and the storage separately.
>
> **v0.14 closes the last unmet row of the conformance checklist (14 September).** New §20.2: the signed anchor, as built. Six fields and an Ed25519 signature over a canonical serialization; the private key lives on the operator's machine and nothing in the Registry can read one. Weekly, and after anything irreversible. Served at `/.well-known/cp-anchor` beside a key list at `/.well-known/cp-keys`, and mirrored where the Registry cannot reach it. A follower compares against the entries it verified for itself and stops on divergence; `verify-journal --anchor` does the same from a laptop. Rotation by a vouched key list, with the first key's fingerprint published to be checked by eye. §25 Q12 closed.
>
> **v0.13 builds the lint §16 has described since v0.1 (14 September).** New §16.1: lint is a function of one document and its published priors, touching no credential, so an author with no authority yet can still be told what is wrong; it never refuses, and the two checks that report a real refusal ground carry `gate: true` beside the advisory ones. Findings, not a score. `POST /<name>/lint` at `register` scope (ruled: public later, deliberately), `lint_profile` in the MCP server, and the findings attached to `?dry_run=true`. The Propagate row is withdrawn — the 2026 parser already refuses a Property that omits it.
>
> **v0.12 makes "held by the operator" true of the table, not just the prose (14 September).** §3.2 gains the `allocation withhold` act: custody of an infrastructure or path-shadowing Prefix by the operator organization, no evidence flag because the policy entry is the evidence, public in the journal because followers exist now in a way they did not at bootstrap. `account` and `auth` were withheld in policy on the 13th and had no allocation row on canon; `custodyGaps()` and `test/withhold.test.ts` are what would have caught that the same hour. `deploy/RELEASING.md` records the nightly backup, how to restore one, and what `audit_chain_verify` proves about a restore.
>
> **v0.11 lets a Prefix change hands (13 September).** §8.4 gains its operator form: `allocation transfer`, evidence required, one audited public transaction, the seam doing the rest; and §9.2 an `organization rename`. §10.2 ruling 4's release path now exists, and its first uses are recorded there. §5 clarifies that the operator is an organization — CNS/CP — distinct from Padi, Inc. §3.2 withholds `account` and `auth` (the §15.3 paths). §25 gains Q13, for OSTERA: whether the specification should standardize the Registry's HTTP interface and reserve the words it needs.
>
> **v0.10 lets people in by themselves (12 September, evening).** New §15.3: a person signs in with Google or GitHub, is linked to their user by the provider's subject or by a verified email that exactly one user carries, and mints and revokes their own tokens on `/account`; the operator's act per author shrinks to one `member add` by email. Sessions are browser state honoured on `/auth/*` and `/account` only — no act on the Registry is ever authenticated by a cookie — and the Registry holds no password. Two tables (migration 11), no new inputs to the seam. Also: §15.2's working pattern corrected to the split scopes; §25's Phase 1 row records the delivery.
>
> **v0.9 issues credentials as rows (12 September, later).** `draft:write` is split into `register · steward · release`; a `credential` table holds hashed tokens with scopes, minted and revoked from an operator CLI inside the cluster and audited; the environment credential becomes the bootstrap form (§15.2, `deploy/CREDENTIALS.md`). This is what a second author needs, and it is what makes the assistant-and-person split real.
>
> **v0.8 answers an outside review of the authorization design (12 September).** Two conformance points, both accepted: the outage fallback to a name's recorded registrant is removed — every write waits when the seam cannot answer (§4.1 rule 2) — and organization status leaves the seam, whose every refusal now maps to a naming requirement, an allocation fact, or the absence of the owner's authorization (§9.3 table); suspension is carried out as allocation locks and grant suspensions (§7.1). Grants name their grantor (`granted_by_org_id`, §6.4, migration 9) and count only from the current holder, which settles Q7(b) and makes transfer revoke grants by default (§8.3, §8.4). The intended assistant-and-person credential split is recorded in §15.2, and a rehearsal needs only `draft:write` (§15.1).
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
| Path-shadowing | `console`, `assets`, `profiles`, `distribution`, `health`, `well-known`, `operator`, `account`, `auth`, `workspace` | A single dotless segment resolves to the allocation it denotes (§19.1), so any reserved path must also be a withheld Prefix or it would be shadowed. Extend both lists together — `account` and `auth` joined on 13 Sept 2026, a day after §15.3 took the paths, which is the failure mode this row exists to prevent. |
| Documentary | `acme`, `xyz` | Conventional fake-company names, serving the same purpose as spec-reserved `example`. `xyz.ics` cites `www.example.com` as its website. Withheld so neither can later be allocated to a real party and be misread. |
| Operator-held | `hello`, `proto` | `hello` is the operator's own (CNS/CP, §5), as are `haystack` and `modbus` (§10.2). `proto` is withheld rather than allocated because its contents come from four unrelated organizations (§10.2 ruling 2). *`padi` left this row on 13 Sept 2026: it is held by Padi, Inc., an ordinary holder carved out of the operator organization by transfer (§8.4).* |
| Restricted | Single-character Prefixes; a published trademark watch list | Allocatable only on review, with recorded rationale. |

**Withheld is not the same as reserved.** The two spec-reserved Prefixes SHALL NOT be allocated, ever, by anyone. A withheld Prefix is this operator's policy choice under spec §7.1 and may be released later by a recorded decision — but while withheld it is held by the operator, so nothing beneath it is ownerless.

**And held means held — there is a row.** "Held by the operator" is not a manner of speaking: `authorizes()` declines to refuse on the withheld list precisely because a withheld Prefix is supposed to have a real allocation behind it, and the allocation page, the snapshot and the seam all read that row rather than this table. The Phase 0 seed makes it true for every entry on the list *at the moment it runs* — and that is the whole of the guarantee. A Prefix added to the list afterwards, on a Registry seeded before, has no row, and the sentence above is quietly false for it. That is what happened to `account` and `auth`: withheld in policy on 13 September, invisible in the allocation table on a canon seeded on the 11th, and protected only by the accident that a route answers those two paths first.

*Ruled 14 Sept 2026.* An operator act closes the gap and keeps it closed:

```
npm run operator -- allocation withhold --tlp account --by anto@padi.io
npm run operator -- allocation withhold --all --dry-run --by anto@padi.io
```

It is custody, not allocation, and it is narrow in four ways. It allocates only to the operator organization. It allocates only a Prefix this policy already withholds, and only in the `infrastructure` and `path-shadowing` classes — the empty names the Registry needs for itself; a `documentary` or `operator-held` entry is seed inventory, with records beneath it, and is refused. It never touches a spec-reserved Prefix, which is nobody's to allocate including the operator's. And it takes no `--evidence`, because unlike an allocation ruling — where the evidence is a fact about the world only the operator has seen — the published policy entry *is* the evidence: the audit event records the rule's own class and rationale.

The event is `allocation.create`, which is public (§20.1). The seed's `allocation.grandfather` is not, and correctly so: bootstrap was a single load that every follower receives whole in the snapshot. A row created now arrives after followers exist, so the journal is the only way they learn of it — and who holds a Prefix is exactly what §7.4 says third parties must be able to check. `--all` works through every gap, one transaction each, so a refusal on the fourth does not undo the three that were sound; `--dry-run` names them and writes nothing.

The check that makes the ruling stick is `custodyGaps()`, asserted in `test/withhold.test.ts`: after a seed there are no gaps, and a Prefix whose row is missing is named. That is the test that would have failed on 12 September, an hour after §15.3 took the paths.

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

That is spec §7.3's requirement made a question: "what the Registry requires is that the authorization exists," while the specification deliberately declines to define its form. §7.3 requires it for every act on a name — registration, publication, Deprecation, a stewardship change, release — and the seam answers the same question for all of them (§11); every one of them waits on it when it cannot answer (§4.1 rule 2). The seam therefore sits exactly where the specification already put a boundary.

Everything else flows the other way, as events: a transfer completes in Part One, and Part Two reacts by updating the `Owner` stewardship field on affected versions and dropping authorization scopes to `offered`. **One query in, events out.** Part Two never writes into Part One, and neither reaches into the other's tables.

Two rules keep the seam honest:

1. **Governance state must never reach the read path.** A suspended organization, a locked allocation, a dispute in flight — none of it may affect resolution of published versions, which spec §9.3 answers to any party regardless. This is easy to violate accidentally with a naive join across the seam.
2. **The authorization query is the only synchronous coupling.** Part Two must remain able to serve *reads* when Part One is unavailable; **every write waits**, with a structured 503 that says so. *(Amended 12 September 2026, on an outside review: until then, deprecation, stewardship and release fell back to the name's recorded registrant during an outage. Spec §7.3 requires the owner's authorization for every act on a name, and a registration is a historical fact, not continuing authority — a member since removed, or a former holder's registrant after a transfer, would have kept acting for as long as the seam was down. Nothing is inferred now.)*

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

**Routing on `cp.` is decided by one rule: does the first path segment contain a dot?** A dot means resolution; no dot means console, API, or infrastructure. The two can never collide, because a Profile name always has at least two segments (spec §7.2) and no console or API path contains a dot. Reserved dotless prefixes: `/console`, `/assets`, `/profiles`, `/distribution`, `/health`, `/.well-known`, `/operator`, `/account` and `/auth` (§15.3), `/workspace` (§20.3). Authoring needs none of its own: it addresses the same paths as resolution and separates by method (§15).

**Credentials.** Session cookies are scoped to `/console` and are neither sent to nor honored on resolution paths; the edge strips them there, so a credential can never enter a cache key. Machine clients use bearer tokens exclusively (§15.1). The console authenticates by OIDC and then calls the same API as every other client — it holds no privileged path of its own. *As built (§15.3): the session cookie is set at path `/`, but only `/auth/*` and `/account` read it — the console paths that exist so far — and no resolution or authoring route consults it, so the same property holds without an edge rule; the edge rule is still the right thing to add when the console grows.*

**One URL per Profile, for people and machines alike.** Typing `cp.cnscp.io/acme.meter.flow` into a browser shows a readable page; the same URL fetched by a Governor returns the document. The two are separated by `Accept` (§19.2), not by different addresses, because the address *is* the Profile's citation — the thing that goes in a specification, an email, or a slide, and works for whoever follows it. `/console` is for authoring, not for viewing.

The rendered page presents the document; it never summarizes it. ARETE.md's warning that summarized views lose key-presence flags is exactly the hazard, so every Property, every attribute, and every version appears explicitly, and the raw document is one click away and named as the contract.

**Two conformance profiles of the `cp.` contract**, so that a local instance is understood as complete rather than deficient:

- **Resolution profile** — every `GET`, per §19 and §20. What every instance implements, `cp.acme.com` included, and what spec §7.4 requires a Governor be able to run locally.
- **Authoritative profile** — the resolution profile plus every other verb on those same paths (§15), plus the console. Only `cp.cnscp.io` implements it.

A local instance may serve a read-only browse view; it never serves the authoring console. A write to a Registry path returns the authoritative host's URL — or, on an instance configured to forward, is relayed there with the caller's own credential (§20.3). The one write surface an instance may carry is the author's workspace beside it (§20.3), which is not a Registry surface. `cp.<organization>` becomes the recognizable convention for a Registry instance.

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

*The operator is an organization too.* The Phase 0 seed created one organization flagged `is_operator` and named it "Padi, Inc." after the company that stood the Registry up, so for a year Padi-the-holder of `cp:padi` and the institution holding every reserved, withheld and unclaimed Prefix were one row. With `/account` (§15.3) showing every member the Prefixes their organizations reach, the two roles want two rows. *Ruled 13 Sept 2026:* the operator organization is **CNS/CP** — the institution that runs the Registry and publishes under `cp.*` and `cns.*`, whose members are the operator's people and nobody else — and Padi, Inc. is an ordinary holder carved out of it by transfer (§8.4).

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
| `granted_by_org_id` | uuid → organization | The organization that made the grant. **A grant counts only while its grantor holds the allocation** (migration 9, 12 Sept 2026): a transfer makes every prior grant ineffective until the new holder re-grants or accepts by re-issuing (§8.4), and a grantee cannot grant onward, because a record it issues names itself, not the holder (§8.3) |
| `granted_by / granted_at / expires_at` | | Revocable at will; revocation never affects already-published versions |

## 7. Lifecycles

### 7.1 Organization

```
applied ──verify──► verified ──first allocation──► active
   │                              ├─suspend (steward)──► suspended ──reinstate──► active
   └─rejected                     └─dissolve──► dissolved
```

- `suspended` is a steward's act with no stated ground in the specification, so **the seam never reads it** (amended 12 Sept 2026): what a suspension *means* is carried out as facts the seam does read — the steward locks the organization's allocations (no new registration beneath them, §7.2, exactly as a dispute hold) and suspends the grants it made. Publication on names the organization already holds is not stopped by it, because spec §9.3 admits no such ground. It **never** affects resolution of published versions: those are immutable, permanent, and answerable to any party regardless of what has become of their author (spec §9.3). Governance churn must be invisible to resolvers (§4.1 rule 1).
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
- On transfer, every grant lapses by default: the seam honours a grant only while `granted_by_org_id` is the allocation's current holder (§6.4), so a former holder's grants stop counting the moment the Prefix changes hands, without a workflow having to find and revoke them. The new holder re-grants, or accepts by re-issuing the record in its own name.

### 8.4 Transfers

- **Voluntary:** initiated by the holder's admin, accepted by the receiving organization's admin, executed after a 7-day cooling window; cancellable, audited.
- **Forced:** dispute outcome, legal order, or recovery from a dissolved organization. Two-steward sign-off, permanent record.
- Published versions travel with the Prefix byte-identical. A transfer changes who may register and publish next; it changes nothing already published. Outstanding grants lapse (§8.3) unless the new holder re-issues them. The new holder may update the stewardship Header fields — `Owner` exists as a mutable field precisely because "a Prefix may change hands" (spec §6.6).

**The operator form, as built (Phase 1, 13 September 2026).** Neither transfer above exists yet: the voluntary one needs an admin on each side (Q7a) and the forced one a steward panel. What Phase 1 needs is narrower and older than both — **the release of a grandfathered Prefix to its evident owner**, which §10.2 ruling 4 promised for `c4sb`, `ibb`, `kubecns`, `novant`, `onuma`, `openjs` and `skycentrics` "on verification", and which §10.2 then noted has no path for a claimant without a domain to challenge. This gives it one, in the mold of §10.2's Phase 0 form: an operator act, evidence required, one audited transaction.

```
npm run operator -- allocation transfer --tlp ibb --to "C4SB (Coalition for Smarter Buildings)" [--create] \
    --evidence "<why this organization is the holder>" --by anto@padi.io
```

`--to` names the destination by exact name or id; it must exist unless `--create` says you mean to make one (then it is created `active`, with `verification = { method: 'operator-ruling', evidence, ruled_by }` exactly as `allocate` creates one), so a misspelling refuses rather than quietly conjuring a second organization and handing it a Prefix. In one transaction the allocation's `org_id` becomes the destination and `allocation.transfer` is written with `before { tlp, holder, org_id }`, `after { tlp, holder, org_id, status, class, grandfathered, expires_at }` and the evidence as rationale. Nothing else changes: `grandfathered`, `class` and the term stay; every published version beneath the Prefix is untouched, because resolution never consults governance state (§4.1 rule 1). It refuses, with nothing written: an allocation that does not exist; one whose status is not `active` (`locked` suspends transfer by §7.2; `redemption` and `released` have nothing to transfer); a destination that is already the holder; an unknown destination without `--create`; and evidence under twenty characters.

What follows needs no workflow. Every grant the previous holder made lapses at once, because the seam honours a grant only while `granted_by_org_id` is the current holder (§6.4); the previous holder's members lose reach under the Prefix on their next request and the new holder's gain it, since `authorizes()` reads the holder on every act and caches nothing. `allocation.transfer` is public in the journal (§20.1), carrying the subject as hashed and the current allocation facts; a local instance applies it by updating its copy of the holder, creating the organization row if it has not seen it. The evidence for a claimant without a web identity is an operator attestation — Q9's second method in its simplest form, with the weakness Q9 names: one person's word, recorded and reversible by another transfer. The two-steward discipline of the forced form is Phase 3's tightening. **First uses (13 Sept 2026):** the operator organization renamed CNS/CP; `c4sb`, `ibb` and `dbp` released to C4SB (Coalition for Smarter Buildings); `arete` to Project Arete; `padi` carved out to a new Padi, Inc.

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
         allocation transfer · organization rename          BUILT 13 Sept 2026 as CLI acts (§8.4 operator form): move a Prefix's
                                                            holder with evidence; rename an organization (display name only,
                                                            same id — every past journal entry still points at the same row).
                                                            Both public in the journal.
POST     /operator/allocations/{tlp}/lock|suspend|force-transfer
GET/PUT  /operator/policy/reserved · /policy/restricted · /policy/limits
GET      /operator/audit                                    full chain, export
```

There is deliberately no endpoint anywhere in the operator plane to alter, unpublish, or withhold a published version. Spec §9.3 forbids all three, so the capability should not exist in the codebase — its absence is the enforcement.

### 9.3 The internal interface Part Two calls

**Every refusal the seam can give maps to a naming requirement, an allocation fact, or the absence of the owner's authorization** — the grounds spec §9.3 admits — and to nothing else (audited against the code on 12 September 2026):

| Refusal | Basis | Register | Existing-name acts |
|---|---|---|---|
| `name-malformed`, `name-single-segment` | spec §7.2 | refused | refused |
| `prefix-spec-reserved` (`example`, `test`) | spec §7.1: never allocated | refused | refused |
| `allocation-not-found` | no allocation, so no owner, so no authorization can exist | refused | refused |
| `allocation-not-active` (`locked`, `redemption`, …) | the allocation's standing; `locked` is §7.2's dispute hold, which suspends transfer and new registration only | refused | **admitted** — the holder still holds |
| `allocation-closed-to-registration` | the holder declining new names beneath its own Prefix (set only by the operator on Prefixes the operator holds: §10.2 rulings 2–3) | refused | admitted |
| `allocation-released` (`released`, `requested`, `reserved`) | no holder | refused | refused — and what is published keeps resolving |
| `no-membership` / `no-covering-scope` | the owner's authorization does not exist for this user | refused | refused |
| `scope-not-active`, `scope-expired`, `scope-not-from-current-holder` | the grant the user relies on is not the current holder's live authorization | refused | refused |

Organization status is not on this list, by design: it is not a ground the specification states, so a steward who suspends an organization expresses it as allocation locks and grant suspensions (§7.1), which are.


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

*13 Sept 2026:* the release path of ruling 4 exists (§8.4, operator form). The first releases are `c4sb`, `ibb` and `dbp` to C4SB (Coalition for Smarter Buildings), on the operator's attestation that their representative is known; the remaining claimant Prefixes wait for a claimant to appear.

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
| **Machine author** | A CI job or AI agent holding scoped credentials and acting for a named human principal. Same API, narrower scopes — normally `register · steward · release`: registration, release, stewardship and rehearsal, none of the irreversible acts (§15.2). |
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
| `registered_by` | uuid → app_user | The registrant the seam confirmed at registration — a recorded fact, conferring nothing (the outage fallback that once read it was removed on 12 Sept 2026, §4.1 rule 2) |
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

The entry alone: that the name is registered, and since when (spec §7.3, §9.3). `GET /<name>:unpublished` is "a reference the Registry never resolves; only a Realm holding its content can" (spec §7.2) — and because the Registry holds nothing, this is not a permission question: no credential changes the answer, and `PUT /<name>:unpublished` is refused with the architecture, not a 403. The token `unpublished` is reserved in the version's place and no version is ever numbered by it. An author may host the unpublished form beside a local instance of its own (§20.3); that host answers `:unpublished` as the author, marked as such, never as the Registry.

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
- **Dry run everywhere.** `POST …/publish?dry_run=true` runs every gate on the document it carries and returns exactly what a real call would, changing nothing. An agent should be able to converge on a publishable document without ever risking an irreversible act, and the lint (§16) is available the same way. *Ruled 12 Sept 2026:* the rehearsal needs `register`, not `publish` — the gate findings are not what the `publish` scope guards, the irreversible act is, and an agent holding the preparatory scopes alone must be able to converge and hand a publishable document to the person who holds `publish`. Only the literal `dry_run=true` is a rehearsal; any other value is refused (400) rather than guessed, because the alternative is an irreversible publication.
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

Credentials are therefore scoped per kind of act, one scope named for each so a token is legible without a glossary: `register` (claim a name; rehearse a publication), `steward` (Owner and Website), `release` (a never-published name), `publish`, `deprecate`, and `operator` for the §9.2 plane, which no authoring credential carries by default. *(Until 12 September 2026 the first three were one scope, `draft:write` — a name from before the Registry stopped holding drafts; the split was the outside review's suggestion.)* A machine author normally holds `register · steward · release` — it can do the whole of the preparatory work, including converging on a document that passes every gate, and none of the damage.

**Credentials are rows** (migration 10, `deploy/CREDENTIALS.md`): the `credential` table holds the SHA-256 of each token, the `app_user` it acts as, its kind, its principal, its scopes, a label, and when it was minted, last used and revoked. The token is shown once, at minting, and stored nowhere. Minting and revoking are done by the person on `/account` (§15.3), or by an operator from the command line inside the cluster (`npm run operator -- credential mint | revoke | list`, with `user find`, `user add` and `member add` beside them) for bootstrap and for machine credentials with no person to sign in; each is audited under the principal who did it, and the journal redacts them. The authoritative host looks a presented token up by hash, so a revoked token is simply absent from the next request on. One static credential from the environment is still honoured, so a fresh deployment can mint its first row; it is meant to be removed once the table carries the real tokens. **The intended working pattern with an assistant** (Anto, 12 Sept): the assistant's token is an `agent` credential with `register · steward · release` and the person as principal; publication and deprecation need the person's own token, presented by the person. Since §15.3 the person mints both on `/account`; the assistant's token then acts under the person's name and the person's own acts under the person directly. The audit chain records both — the agent's preparatory acts under the person's name, and the irreversible act under the person directly. Beyond that, an owner's publication policy (§14) may require that publication by a `service` or `agent` identity carry a human approver, which is a natural use of the owner-gates mechanism and keeps the requirement out of the Registry's own refusal grounds (spec §9.3).

Deprecation is deliberately *not* on the irreversible list — it is reversible in practice, since re-publishing the same content as a new version is always available, and it is the safety valve when something published turns out to be wrong.

### 15.3 Identity: who a user is, and how a person gets in

Everything above answers one question — *may this user do this intent on this name?* (§9.3) — and assumes the user already exists. Until 12 September 2026 a user existed because an operator typed an email (`user add`), which made the operator the bottleneck for every author and left the operator holding a token that had to be carried to its owner by hand. This section separates the two questions properly. **Identity** — who is this? — is the person's to assert, by signing in. **Authority** — what may they do, and under which Prefix? — stays where it is: membership of the holding organization (§5, §6.2), granted by the operator today and by the organization's own admins later (Q7a). The seam never learns that anything changed, because nothing in its inputs did. *Ruled 12 Sept 2026 (Anto): every user who wants to interact with the Registry starts by creating an account attached to an email; the operator looks a user up by email and attaches them to an organization that owns Prefixes. Built before the first outside author was onboarded, because the hand procedure would have been used once and retired, and the people after him are the point.*

**Sign-in, not passwords.** A person signs in with Google (OpenID Connect: authorization code with PKCE, the ID token verified against Google's published keys) or GitHub (OAuth 2.0, with the verified primary email from the GitHub API). The Registry stores no password and asks for nothing beyond the basic identity scopes. The only secrets involved are the two client secrets and a cookie-signing key, and those are deployment configuration, not data: *the Registry holds no secret it did not mint.* The providers sit behind one small interface (`src/identity/providers.ts`, no library — both flows are readable in one file), and the choice of these two is a Phase 1 convenience, not a design property: a Registry aiming at a Recommendation cannot have a single vendor as its only front door forever, and nothing below depends on which providers exist. Both are configured in the Registry's own Google Cloud project (`cnscp-registry`) and GitHub organization (`CNSCP`), so a future change of steward moves no accounts — Google's and GitHub's subjects are stable across clients.

**Data** (migration 11):

| Table | Holds |
|---|---|
| `user_identity` | `app_user_id`, `provider` (`google · github`), `subject` (the provider's stable identifier), `email`, `email_verified`, `display_name`, `first_seen`, `last_seen`. Unique on (`provider`, `subject`). One user may have several. |
| `session` | `app_user_id`, the SHA-256 of a random session id, `created_at`, `expires_at`, `last_seen_at`, `revoked_at`. The browser holds the id in an `HttpOnly; Secure; SameSite=Lax` cookie, HMAC-signed with the deployment's session key so a forged cookie fails before the database is consulted. |

`app_user.oidc_subject` (§6.2) is retained and no longer read by the sign-in code; `user_identity` is authoritative for identity from here on.

**The linking rule** — the one decision that matters, applied in one transaction at every sign-in, in this order and no other:

1. An identity with this `provider` and `subject` is known → this is that user. Nothing else is consulted; a later change of email at the provider does not move the account.
2. Otherwise, the provider asserts the email is verified, and exactly one `app_user` carries that email (case-insensitively) → the identity is attached to that user. This is how a row the operator created in advance is claimed by its owner on first sign-in, and how a Google identity and a GitHub identity with the same email land on the same user rather than two.
3. Otherwise → a new `app_user` is created with the verified email and display name, and the identity is attached to it.

An unverified email never links and never creates: the sign-in is refused with a message saying so, and nothing is written. An email carried by more than one user is refused for an operator to resolve. Email is a linking key at first sight only; the provider's subject is the durable key thereafter.

**Sessions are not credentials.** A session belongs to a browser, expires (seven days idle, thirty days absolute), and is honoured on exactly two surfaces: `/auth/*` and `/account`. No authoring or operator route ever authenticates by cookie; every act on the Registry still presents a bearer token (§15.2) and passes the same scope check and the same seam. That keeps cross-site request forgery against the authoring API structurally impossible — the test suite registers and publishes with only the cookie and gets `401` both times — and it keeps the audit chain's notion of *who acted* exactly what it was: a credential, acting as a user, for a principal. The account page's own forms carry a per-session token against forgery.

**`/account`.** A signed-in person sees their identities; their memberships, each with its role and the Prefixes the organization holds — which is to say, where their tokens may act; and their credentials, with label, kind, principal, scopes, when minted, when last used, and a revoke control for their own. They may mint a credential: kind `human` (acting as themselves), or `agent` or `service` (acting as themselves, with themselves as principal, for an assistant or a CI job — the three kinds the `credential` table admits), a label, and any subset of the author scopes `register · steward · release · publish · deprecate`. The token is shown once. `operator` cannot be minted here under any circumstances; it remains a command-line act inside the cluster. Minting does not require a membership — *where a token may act is not on the token* (§15.2): a credential for a user with no memberships is refused by the seam with `no-membership` on every act, and becomes useful the moment the operator attaches its owner to an organization. Mint and revoke write the same `credential.mint` and `credential.revoke` events as the CLI, under the user's own principal with `actor_kind = human`; the journal redacts them as before.

**What the operator still does.** Attach a person to the organization that holds a Prefix: `member add --org … --user <email>` (existing), with `user find --email` beside it to see what the Registry knows about that address. That is the whole of the operator's involvement per author, and it happens after the person exists, on the strength of an email the operator already knows. The first member of an organization is always the operator's act; adding the rest is the organization's own once Q7(a) gives `member.role = admin` its mechanism — the role column has existed since §6.2 for exactly that.

**What is written to the audit chain.** `user.create` (now by the person themselves, on rule 3) and `user.identity_link` (rule 2), both non-public and redacted in the journal; `credential.mint` and `credential.revoke` as today. Sign-ins and sessions are application log, not registry acts.

**Configuration.** `CP_OAUTH_GOOGLE_CLIENT_ID/SECRET`, `CP_OAUTH_GITHUB_CLIENT_ID/SECRET`, `CP_SESSION_SECRET`, and `CP_PUBLIC_ORIGIN` (the origin the callbacks are registered against: `https://cp.cnscp.io` on canon, `http://localhost:8082` on a Mac). The identity routes mount only when all six are present — some but not all is a startup error — so a host without them is exactly the host of §15.2. The Google app is External and in production with only the basic scopes, which needs no Google review; a logo would, so it has none yet. `deploy/CREDENTIALS.md` has the procedure.

**Deliberately not built.** Passwords; magic-link email (an outbound-mail dependency for the few people without either provider — revisit when one appears); an organization-admin surface (Q7a); an operator web console; account deletion (an operator act, when someone asks); organization SSO.

## 16. Contract lint (owner-side, advisory)

Runs on demand, and at publication when the owner's policy asks for it. Never a Registry refusal ground. Its results are structured like every other response (§15.1), which makes it the practical guardrail for machine authors: an agent lints, reads the findings, revises its document, and repeats — the permanence warning in particular matters most when properties are being generated rather than deliberated.

| Check | Rule |
|---|---|
| Header completeness | All REQUIRED fields present (spec §6.6) — this one *is* a Registry gate; listed because the editor surfaces it inline |
| Property naming | Purpose-named; flags direction prefixes (`in_`, `out_`, `server_`, `client_`, `tx`/`rx`, `send`/`recv`) — the supplying role is structural, so encoding it in a name is redundant and misleading |
| ~~Propagate deliberate~~ | *Withdrawn 14 Sept 2026 (§16.1): the 2026 parser refuses a Property whose Propagate is absent or is anything but `"yes"`/`"no"`, so the decision is already compulsory and the check could never fire.* |
| Non-capture | No Header or Property text conditions enactment on a named Governor or Realm (spec §5.3), and no realm policy embedded (spec §6.7) — both are conformance requirements for a Profile (spec §9.4) |
| Additivity preview | Diffs the candidate document against every published version and reports what would be rejected, before the author publishes — this is what `?dry_run=true` already does at the gate |
| Permanence warning | Flags newly added Properties: once published under this name they can never be removed (spec §6.2 NOTE) |

There is deliberately no "mode" check: the specification defines no mode field, and the 8 Sept revision removed the direct-route concept altogether — everything a Connection carries passes through the Realm (spec Appendix B.2), so there is nothing for a marking to distinguish.

### 16.1 As built (Phase 1, 14 September 2026)

The table above says what lint checks. This says what lint *is*, which the table left open in three places: what it runs on, what it returns, and what — if anything — it may stop.

**It is a function of one document.** `lint(profile, { priors })` takes the candidate and, where a check needs it, the versions already published under that name. It touches no credential, no membership and no allocation, so it can answer for an author who has no authority yet — which is the property that makes it the front door rather than a late gate. *A refusal an author can only discover by attempting the irreversible act is not a guardrail; it is a trap.*

**It never refuses.** Publication has exactly the grounds §14 and spec §9.3 name, and lint adds none: a document with twelve findings publishes if it is conformant, and a document with none is refused if it is not additive. Two checks report what the gate will do anyway — header completeness and additivity — and those carry `gate: true`, so one list shows both what will be refused and what is merely unwise. The test suite asserts the separation in both directions, because a lint that can refuse is house style with a gate, and a registry that imposes house style has stopped being a substrate.

**Findings, not a score.** Each carries `check` (a stable id), `severity` (`refusal · warning · note`), `where` (a path: `Header.Owner`, `Properties[3].Name`), `message`, `spec` (the clause it rests on), and `gate` where it is also a refusal ground. There is no total and no "lint passed": a count invites clearing the count, and the findings are meant to be read. `tally()` exists for a caller that wants one line, and is documented as not being a score.

| Check | Severity | Rests on |
|---|---|---|
| `header.incomplete` | refusal · gate | §6.6 — Version, Pub Date and Status are exempt; the Registry assigns them at publication |
| `profile.malformed` | refusal · gate | §7.2, §9.4 — the name, a reserved Prefix, no Properties |
| `property.duplicate` | refusal · gate | §6.4 — Properties and Channels share one name space |
| `version.additivity` | refusal · gate | §6.2 — the same function the publish gate calls, so the preview cannot drift from the gate |
| `property.direction-prefix` | warning | §6.3 — the supplying role is structural; a name that encodes direction is redundant where it agrees and misleading where it does not |
| `profile.non-capture` | warning | §5.3, §6.7 — Header or Property text conditioning enactment on a named Governor or Realm |
| `channel.performance-claim` | warning | §6.5 — latency and throughput are properties of a deployment, not terms of a contract |
| `version.permanence` | note | §6.2 NOTE — every newly added Property, named |

**The permanence note earns its place.** It fires on every addition, not only suspicious ones, because the point is the pause rather than the detection: a person reads spec §6.2's NOTE once and remembers it, and a machine generating twenty Properties does not. On a first version it says so plainly — every Property in it is permanent from publication.

**Propagate is not checked, and the table's row for it is withdrawn.** §16 asked that every Property's Propagate be explicitly chosen rather than defaulted. In the 2026 shape it cannot be defaulted: `parseYesNo` refuses a document whose Property omits it, or carries anything other than `"yes"` or `"no"`. The requirement is met by the parser, and a lint check for it could never fire.

**Where it appears.** `POST /<name>/lint`, guarded by `register` — the same scope a rehearsal needs. `lint_profile` in the MCP server, which is the surface that matters most: an agent that lints, reads, revises and re-lints is the working pattern §16 was written for. And the findings ride along with `?dry_run=true`, so a rehearsal answers both questions at once — *would this be refused* and *is this a good idea* — without the author having to know to ask twice.

*Ruled 14 Sept 2026 (Anto):* `register` scope now, public later and deliberately. A public lint endpoint would let anyone evaluating CNS/CP try the Registry without being onboarded, which is worth having; it would also be an unauthenticated endpoint accepting arbitrary document bodies on a Registry with no rate limiting anywhere. Opening it later is available; closing it again is not.

**What lint does not do.** It does not check spelling, style, or the shape of a Description, and it does not know what a good Profile looks like. Every check above cites a clause of the specification or an irreversibility in this Registry. A check that can cite neither does not belong in the list.

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
5. **Never write to the namespace.** Instances are resolution-only for the Registry's content; the Part One and Part Two APIs exist solely at the authoritative store, and an instance that forwards does so as a pipe (§20.3). Many instances, one namespace (spec §7.3).

Unpublished content never appears in the feed, for the simple reason that the authoritative store holds none (spec §7.3); an instance's Registry surface answers `:unpublished` exactly as the authoritative host does, and a workspace beside it answers as the author (§20.3).

### 20.1 The feed, as built (Phase 1, 11 September 2026)

Built on the resolution profile, so the authoritative host and every instance serve the same three routes; §21 makes the shapes below additive-only from here on. `journal_format: 1`.

**`GET /distribution/snapshot`** — one consistent read (a `REPEATABLE READ` transaction): the chain head at that instant as `head: { seq, event_hash }`, which is also the cursor to follow from; every allocation as the §19.3 stable public facts (`id`, `tlp`, `holder`, `org_id`, `grandfathered`, `class`, `allocated_at`) — never `status`, never `pending_claimant`; every registered name (`id`, `name`, `registered_at`, `imported_from`, `allocation_id`); every published version with its document (`id`, `name`, `version`, `status`, `published_at`, `content_hash`, `owner`, `website`, `grandfathered`, `pub_date_approximate`, `missing_header_fields`, `document`). Identifiers are the authoritative store's own, so a journal entry that names a version by id lands on the same row everywhere.

**`GET /distribution/journal?since=<seq>&limit=<n>`** — the audit chain of §4.3, projected. Every event with `seq > since` appears, in order, so the chain is contiguous and an instance can check every link. Two entry shapes:

- **Public acts** — `profile.register`, `profile.publish`, `profile.deprecate`, `profile.stewardship`, `profile.discard`, `allocation.create` — carry **the exact preimage of `event_hash`**: `at` (formatted as the chain function formats it), `actor`, `actor_kind`, `principal`, `org_id`, `action`, `subject_type`, `subject_id`, `before_hash`, `after_hash`, `rationale`, `request_id`, `prev_event_hash`, `event_hash`. A verifier recomputes the hash from these and needs nothing else. *Ruled 11 Sept: `principal` and `rationale` are published.* §4.3 already said "who published this" ends in a person and §15.1 that rationale is published where the act is; a feed that withheld them could not be verified against the log, and a chain nobody outside can verify is decoration.
- **Everything else** (`organization.create`, `member.add`, the bootstrap's `allocation.grandfather` rulings — whose payload names the pending claimants §19.3 keeps off the page — and any act added later) appears **redacted**: `seq`, `action`, `prev_event_hash`, `event_hash`, `public: false`. The link is checkable; the content is not published.

Alongside the preimage, a public entry carries what an instance needs to apply it. `subject` is the `after` payload the act hashed — from `audit_event.after_payload`, stored by migration 7 beside its hash for every event written from then on (`subject_source: stored`). For earlier registrations, publications and deprecations it is **rebuilt from the immutable row in the shape `record()` used at the time** (`subject_source: reconstructed`), so `after_hash` stays checkable back to genesis; an early stewardship act has no subject, because the row it changed may have changed again. `document` (on `profile.publish`) is the frozen version, and `contentHash(document)` must equal `subject.content_hash`. Courtesy fields — `ref: { name, version }`, `registered_at`, `published_at`, `status`, `owner`, `website`, `allocation: { tlp, holder, grandfathered, class }` — are read from the current rows and are **not** covered by the hash; from migration 7 on, `registered_at` and `published_at` are inside the hashed payload as well. What the chain proves, therefore: which acts happened, in what order, by whom, and — for every publication — exactly what content. What it does not prove for pre-migration events: the timestamps the courtesy fields report.

Paging: `limit` 1–1000 (default 200); the response carries `next` (the last `seq` served) and `more`, and `head` (the chain head now) only on the page that reached it — so a full page has no moving part and is served `immutable`, while the last page is `no-cache`. An instance serves the journal from its own verified copy, from its bootstrap point onward; asked for earlier, it answers `416` with `earliest_seq` and the authoritative host's URL.

**`GET /distribution/status`** — `{ role: "authoritative" | "instance", journal_format, head, upstream, cursor, lag_seconds, last_sync_at, anchor }`. *Superseded 14 Sept 2026 by §20.2:* `anchor` now carries the latest signed anchor and its age on both roles.

**The instance** (`npm run instance`, entrypoint `src/instance-server.ts`) is the resolution server plus a follower. On an empty database it bootstraps from the snapshot in one transaction and records `head` as its cursor; thereafter it polls the journal, and for each page checks that the first entry's `prev_event_hash` is the cursor it holds, recomputes every `event_hash`, verifies every `document` against `subject.content_hash`, applies the public acts to its own `profile`, `profile_version`, `allocation` and `organization` rows under the authoritative identifiers, keeps a verbatim copy of every entry in `journal_entry`, and advances `instance_state` — all in one transaction per page, so a break in the chain leaves the instance exactly where it was, with the break reported on `/distribution/status`. It never writes an `audit_event` of its own: it is not a writer. Any non-`GET` on an instance answers `405` with the authoritative host's URL (§4.4). `npm run verify-journal -- <host> [--resolve]` is the same verifier as a standalone tool, for a party that runs no instance: it walks the chain, and with `--resolve` fetches every published version from the host and checks that what is *served* hashes to what the act *recorded* — spec §9.3's "independent parties can detect whether copies agree", performed by one. Proven in test against the real corpus: after bootstrap and after one of every public act, an instance answers every resolution URL byte-for-byte as the authoritative host does, `Content-Digest` included.

### 20.2 The signed anchor, as built (Phase 1, 14 September 2026)

§4.3 has the operator "periodically publish a signed anchor of the chain head", §20 has instances verify against it, and §22's last row leans on it. Until today `/distribution/status` answered `anchor: null`. This is the smallest thing that does the job.

**What the chain already does, and where it stops.** Every event carries `prev_event_hash` and an `event_hash` computed from its own fields in the transaction that wrote it; a follower recomputes both and refuses to advance on a mismatch. That catches alteration, deletion, reordering and gaps — all of it *internal* consistency, which has exactly one blind spot. An authoritative host can keep two chains, the real one and one in which a version says something else, and serve one to each party. Both verify. Neither party can tell, because the only thing either has to check against is the chain that same host handed them. That is a fork, and it is what spec §7.4 has in mind.

**What an anchor is.** Six fields and a signature, over a canonical serialization whose field order is fixed in one place (`ANCHOR_FIELDS` in `src/distribution/anchor.ts`) so a signer and a verifier cannot drift apart:

```json
{ "journal_format": 1, "origin": "https://cp.cnscp.io", "head_seq": 207,
  "head_event_hash": "cba71c3f…408fe768", "at": "2026-09-14T03:11:02Z",
  "key_id": "cp-anchor-2026-09", "signature": "…" }
```

Ed25519, detached, via Node's `crypto` — no JWS, no certificate chain, no dependency. It claims one thing: *at this moment, the head of my chain was exactly this.* Nothing about content being correct, and nothing at all about events after `head_seq`.

**The key is not the Registry's.** `src/distribution/anchor.ts` has no code path that reads a private key: it canonicalizes, verifies, and compares. Signing lives in `src/anchor/sign-cli.ts` (`npm run anchor`), which runs on the operator's own machine, reads the key from `~/.cp-registry/anchor-key.pem` (mode 0600), fetches the head over ordinary HTTP like any other client, and prints the signed document. Publishing is a separate step, so nothing that signs needs credentials for the cluster and nothing in the cluster ever needs the key. *A key the Registry can use to sign is a key that can sign a forked head, and an anchor signed by the thing that could fork proves nothing it was built to prove.* **The Registry signs nothing. The operator does.**

**Cadence.** Everything up to the last signed head is attested; everything after it is not. So cadence is the size of the window a fork could hide in, and it follows the acts rather than the calendar: an anchor **after anything irreversible** — a publication, a deprecation, an allocation, a transfer — **and weekly regardless** (*ruled 14 Sept 2026*). The weekly floor is what makes a quiet week an attested quiet week rather than an absence. Missing one is not silent: `/.well-known/cp-anchor` and `/distribution/status` both carry `age_seconds`, because a host that cannot forge a signature can still serve an old anchor and hope nobody reads the date.

**Where it is published.** `GET /.well-known/cp-anchor` on the authoritative host, and the same document committed to a public repository the Registry does not control. The first is where a follower looks; the second exists because the first is served by the very host the anchor polices. A disagreement between them is not an inconvenience, it is the evidence.

**How a follower uses it.** `checkUpstreamAnchor()` fetches the anchor, verifies the signature against a key it already trusts, and compares at the anchored sequence. `ok` when the event hash it verified there equals the signed one; `diverged` when it does not, which records the sequence on `instance_state.last_error` and stops the instance advancing; `ahead` when the anchor is past its cursor, which is simply not having caught up; `before-bootstrap` when the anchored sequence predates its snapshot, where there is nothing local to compare. An absent anchor is not an error — §20.2 is what is missing in that case, and the chain still verifies by hashes.

**The comparison is against what the follower verified, never a re-fetch.** `journal_entry` (migration 7) already holds the event hash at every sequence the instance has followed, so the evidence is what it saw at the time. Re-fetching that stretch from upstream would be worthless: a host serving a fork would serve the fork that matches its own anchor.

**The root key, to be checked by eye.** The first key was generated on the operator's machine on 14 September 2026 and is the trust root for everything above. It is vouched for by nothing in this mechanism — that is what makes it the root — so it is published here, in the README and on cnscp.io, for a person to compare:

```
key_id      cp-anchor-2026-09
public_key  Rj9bGQe5TSJWmlcQoa4lJer0oj4r9lL6TJQQrqhDynI
fingerprint 463f 5b19 07b9 4d22 569a 5710 a1ae 2525 eaf4 a23e 2bf6 52fa 4c94 10ae a843 ca72
```

If an anchor you are handed names a key whose fingerprint is not this one, and is not vouched for by a chain leading back to it, it is not this Registry's anchor whatever it says in its `origin` field.

**Rotation.** `anchor_key` (migration 12) holds each key's id, public key, validity dates, and — for every key after the first — the predecessor's signature over its canonical form, served at `GET /.well-known/cp-keys`. `keyIsTrusted()` walks from the key in question toward a root the verifier already believes in, iteratively, so a cyclic list terminates unvouched rather than looping. The first key is vouched for by nothing in this mechanism; its fingerprint is published in this section, in the README and on cnscp.io, to be checked by eye. That is the honest trust root available to a registry of this size, and naming it as such is better than dressing it up.

**What is served is what was signed.** The first anchor this Registry published verified when it was received and failed as it was served: the signer wrote `at` without milliseconds, the `timestamptz` column gave them back, and the canonical bytes moved. The signature was never wrong; the stored form was. So the `at` field is stored verbatim in `anchor.at_text` (migration 13) and served from there — `signed_at` remains only for ordering and `age_seconds` — and `anchor publish` re-reads what it just wrote and verifies THAT before the transaction commits. *A Registry must not serve an anchor it cannot itself verify.* The lesson generalizes past this field: anything a verifier hashes is stored as the bytes that were signed, never as a value the database is free to re-format.

**One anchor per head per key, and contradictions are kept.** `recordAnchor` refuses a *second, different* head signed for the same sequence under the same key rather than storing it quietly — two signatures over one sequence is the fork made visible, and it must reach a person rather than a table.

**From the outside.** `npm run verify-journal -- https://cp.cnscp.io --anchor cp-anchor-2026-09` walks the journal, then checks the signed head against the walk and exits non-zero on a fork. No instance, no credential: the audit is a laptop and a few seconds, which is what makes it something people will actually do.

**What it does not do.** It says nothing about whether a Profile is right. It protects nothing after the last anchor. It is worth nothing if the key moves where the Registry can reach it. And it assumes one authoritative Registry per namespace — several mutually distrusting registries writing to one shared namespace is the problem consensus systems solve, and would need a different answer; better stated as an assumption than left unexamined.

### 20.3 The workspace beside an instance (built 21 September 2026)

§13.2 places the unpublished form with its author: "its content lives with its author, outside the Registry, and reaches another party only as the author conveys it" (spec §6.3, §7.3), and "how an unpublished Profile's content is conveyed to a partner, and in what form, is outside this specification" (spec §7.3). Until now that meant a file on the author's disk and whatever means the author found to hand it over. This section gives the author a better means without moving the content an inch: **a workspace, run by the author's own organization, on the same host as its local Registry instance.** An organization's instance holds that organization's unpublished forms beside its mirror of canon; a testing partner reads `cp:acme.foo:unpublished` from it the way they read `cp:acme.meter.flow:2`; the author saves, tests, reshapes and, when ready, publishes to canon exactly as before. Nothing in it is new to the specification — it is spec §7.3's sentence made literal, on the author's host. `cp.padi.io` is the first such host, not the pattern's owner.

**The alternative, considered and rejected.** The operator could host a drafts service at `cnscp.io`. It would be legal on paper — the content would still be "wherever the author keeps it" — but it would put unpublished content back on the operator's infrastructure two weeks after the 8 September revision took it off (§24.5, migration 6), and an outsider could not tell from the outside that the line was still there. The author's own host is the version of this idea in which the line is visible.

**Who runs one, and where.** The same image and the same two settings, in three postures. *Inside a security boundary:* an implementer's own network, reachable by their Nodes and Governors and nobody else — the research, development and testing posture, where "open reads" means open to everyone inside the boundary and the boundary is the disclosure. The follower needs one outbound path, to its upstream; nothing needs an inbound one. *In public*, as `cp.padi.io`: the conveyance posture, where partners outside the organization test against the organization's drafts. *Chained:* a private instance may follow a public one of the same organization rather than canon, since every instance serves the journal from its own verified copy (§20.1) — one egress point for the boundary, and the anchor checks the chain wherever it was fetched from. The two workspaces in that chain do **not** replicate each other's drafts: unpublished content is never in the feed, so a draft moves from the inside host to the public one only by the author's own `PUT`, which is what "as the author conveys it" means. A workspace with no upstream at all — a laptop evaluating CNS/CP, holding `test.*` forms and nothing else — is permitted by this design and not yet built (the instance's boot still requires an upstream).

**Two things on one host, and the wall between them.** A local instance is a Registry — spec §7.4 calls it "a local Registry instance", and spec §9.3 says a conforming Registry "SHALL NOT hold, serve, or answer for the content of an unpublished Profile." So the unpublished form is not *in* the instance; it is *beside* it, and the host wears two hats that an outsider can tell apart:

- **The Registry surface** — the instance of §20.1: the mirror of canon, byte for byte, verified against the chain and the anchor. It answers bare names, integer versions, the catalog, the allocation pages and `/distribution/*`, and it holds no draft columns. Its machine representations are identical to canon's whether or not a workspace is beside it (`test/workspace.test.ts` asserts this over the whole surface, before and after publication), so `verify-journal --resolve` against the host keeps meaning what it means.
- **The workspace surface** — the author's: one table of its own (`workspace_profile`, in its own migration set `migrations/workspace/`, applied by `npm run migrate:workspace` and recorded in its own table, so canon's schema never gains it), reachable only at `:unpublished` references and at `/workspace`, marked on every answer, never in the feed. The instance's follower never writes it and the workspace never writes the mirror; `src/workspace/store.ts` reads `profile`, `profile_version`, `allocation` and `organization` and writes none of them. That is §12.1's enforcement applied in reverse — the Registry surface cannot hold what it has nowhere to put, and the workspace cannot alter what it has no path to.

The two partition the reference grammar of spec §7.2 and never both answer one URL: `/acme.foo:unpublished` is the workspace's; `/acme.foo` and `/acme.foo:2` are the Registry's. A bare name is a selection among *published* versions (spec §8.6) and never selects the draft, on this host as on any other, so a Governor resolving `cp:acme.foo` gets exactly what canon would give it — including "registered, Unpublished, since <date>" when nothing is published. Only the human page composes the two: the name page and every version page gain an **Unpublished** pill beside the version pills, and the catalog's and allocation page's "Unpublished" becomes a link on this host, for the forms it holds. The `/profiles/` legacy alias never serves a draft, and neither does the legacy representation at any URL: the 2022 shape has no Unpublished status to carry, and a deployed SDK that resolves the old way must not be handed a draft by accident.

**What the workspace holds.** One unpublished form per name, for two classes of name and no other:

- **Names its organization holds.** `WORKSPACE_ORGS` names one or more organizations by id (stable across the §8.4 rename act), and the rule is checked at every read and write against the allocation and organization rows the instance already mirrors from the snapshot — the name is registered, and the holder of its Prefix is one of those organizations. This makes "lives with its author" literal: an organization's host can never hold anyone else's drafts. A name released (`profile.discard` in the journal) or whose Prefix has moved (`allocation.transfer`) no longer qualifies; its draft goes dark on the next read and is swept after the next sync, because a draft under a name nobody holds belongs to nobody.
- **`test.*` names.** Spec §7.1 reserves `test` "for local exercise, never globally resolvable", and spec §6.3's note names it as the place for "an author who needs to exercise an unpublished Profile against Nodes in private". Nothing under `test` is ever registered or published, so no organization holds it and no mirror row can vouch for it: a `test.*` form is a draft that belongs to whoever runs the workspace, exists nowhere else, and is the whole of the research-and-development case — the Profile an implementer exercises before they hold a Prefix, or before they are ready for even the name to be public (registration is public, spec §7.3). `WORKSPACE_TEST=true` admits them. The software cannot tell a private host from a public one, so the setting is off unless set, the private runbook sets it, and the public one leaves it alone — because "never globally resolvable" is a statement about the Registry, but a public host serving `test.*` at a public URL is close enough to the line that it should be a choice someone made. A `test.*` form has no published versions to be compared with, so its pill says only "Unpublished · test".

There is no third class. A workspace does not hold drafts for unregistered names under a real Prefix, nor for names under a Prefix nobody has been allocated: whose would `acme.foo` be, before anyone holds `acme`? Before allocation, the work is `test.*`; after registration, it is at the name its versions will occupy (§24). The road from one to the other is the author's, not the workspace's: when a Prefix is allocated and a name registered, the author saves the form under the new name — `Header.Name` changes, which is the one edit the move requires — and the `test.*` form is deleted or kept as the author likes. Nothing carries over automatically.

**Reads are open.** `GET /<name>:unpublished` needs no credential, on the same terms as resolution. Three reasons, in ascending order of weight. It is what makes an unpublished Profile as easy for a partner as a published one. The specification is already comfortable with it: a Realm that binds an Unpublished Profile "SHALL publish that Profile's content in full … available to any party without condition" (spec §6.3), so open reads at the workspace disclose nothing that binding would not disclose a moment later, and private exercise has the `test` Prefix (spec §7.1). And it is a non-capture guarantee — below — because a workspace that answers everyone identically cannot answer some Realms differently. Inside a security boundary, "open" is open to the boundary: the workspace does not authenticate readers, and who can reach the host is the network's decision, not the workspace's. The disclosure duty of spec §6.3 falls on the Governor that binds, not on the host that conveys.

A workspace answer is unmistakably not a published version. The document is served in the 2026 shape with `Header.Status` stamped `Unpublished` and no `Version` and no `Pub Date` — the mirror image of what canon stamps at publication (§13.4) — with `x-cp-surface: workspace`, `x-cp-status: unpublished`, `Cache-Control: no-store`, an `ETag` that is the hash of the stored form and nothing that claims immutability: no `Content-Digest`, no `immutable`. The `ETag` matters beyond caching: a Governor that takes the draft in under its Realm's rules can record exactly what it took in, and operate from that copy (spec §7.4), learning of the author's next change through Reconcile rather than by being surprised at Match. The HTML page draws the document with the same renderer as a version — every Property, every attribute, nothing summarized — under a banner that says whose working copy this is, on which host, that it is not held by the Registry, that it may change at any time, that Connections bound against it are provisional (spec §6.3), and when and by whom it was last saved.

**Writes.** `PUT /<name>:unpublished` with the document in the body saves the form; `DELETE /<name>:unpublished` removes it. The workspace checks three things and no more: that the caller holds the workspace credential; that the name is one the workspace holds (registered under a Prefix one of its organizations holds, or `test.*` where admitted); and that `Header.Name` equals the name, so the page can never draw one Profile under another's citation. It does not lint, does not check additivity, does not require a Property — those are publication's questions (§14, §16), and the unpublished form "is not a contract" (spec §6.3). Anything the author sends in `Version`, `Status` or `Pub Date` is dropped on the way in, because those are the Registry's to stamp. There is one unpublished form per name, so with co-authors the last writer would win: a `PUT` over an existing form carries `If-Match` with the `ETag` it read and is refused `412` if the form has moved and `428` if the header is absent; a `PUT` that creates needs neither, and one that carries an `If-Match` with nothing to match is refused rather than ignored. The row records `updated_at` and `updated_by` (the credential's label and principal), and that is the whole record — drafts are not acts, so they never touch `audit_event` or the journal. `GET /workspace` lists every form the host holds, with where each stands against what is published; the Workspace link appears in the service navigation only on a host that runs one.

**Credentials: one per surface, and the host itself checks one.** Every `GET` on either surface is open. Non-`GET` on a Registry path answers `405` with the authoritative host's URL, or, where the host forwards, carries the caller's own canon token to canon (below). Non-`GET` on `:unpublished` carries the workspace credential, in `Authorization: Bearer` like every other credential in this design, so that when the check's implementation changes the clients' calls do not. The first implementation is the environment form §15.2 already describes for bootstrap (`src/workspace/credential.ts`): `CP_WORKSPACE_TOKEN` (32 characters or more), or `CP_WORKSPACE_TOKENS` as `label=token` pairs, with `CP_WORKSPACE_PRINCIPAL`, in the instance's own secret; compared in constant time. It carries no scopes because there is only one act it enables, and its reach is not on the token: `WORKSPACE_ORGS` fixes what the workspace will hold, so a leaked workspace token can overwrite one organization's drafts on that organization's host and nothing else. That bounded blast radius is what makes an environment credential acceptable here where it stopped being acceptable on canon; it also means the workspace cannot tell an author from an assistant, so two tokens with two labels is the discipline until the second implementation replaces it (§25 Q14). The check is one function, `mayWriteWorkspace`, so that it can take other forms without the routes knowing.

**The host never holds a canon credential.** If it did, anyone who could write the workspace could act on canon as the organization, and the wall would be gone. The instance's configuration is its own database, `UPSTREAM_URL`, `WORKSPACE_ORGS`, `WORKSPACE_TEST`, the workspace credential, and the anchor's public key it already trusts. No `/account`, no sessions, no cookies, no OAuth secrets, and never the anchor's private key. A host configured with a workspace but no credential, or a credential but no workspace, refuses to start: a workspace nobody can write to is not one, and a credential that unlocks nothing is a mistake.

**After publication, nothing happens, which is the point.** "The unpublished form persists, still mutable" (spec §6.3): the pill stays, and version *n* arrives through the feed like any other act. The page says whether the form has moved on since — the draft's contract fields (Properties, Channels, and the Header less the fields the Registry stamps or stewardship may move) are compared with the latest published version's — so the pill reads "Unpublished · same as v2" or "Unpublished · moved on since v2" and is informative rather than decorative. Release is the one lifecycle event the workspace reacts to, above.

**Non-capture (spec §5.3).** "A Connection Profile SHALL NOT condition its enactment on the identity of any Governor or of any Realm, and conformance to a Profile SHALL NOT depend on where it is enacted." A host that holds an organization's unpublished Profiles and also mirrors the Registry is a place where that rule could be bent without anyone writing a line that says so, so each way it could be bent is named here with the invariant that closes it.

1. *Publication by other means.* An author keeps a Profile unpublished for good, partners bind it under their Realms' rules, and the result behaves like a contract that only the author can change and that only the author's host can supply — enactment conditioned on a party. The specification's own answer is that such Connections are provisional and that a Realm binding the Profile must publish it; the workspace's answer is that a draft can never be mistaken for a version by anything that matters: never selected by a bare name (spec §8.6), never on the legacy alias, never carrying `Content-Digest` or an immutable cache life, always stamped `Unpublished` with no `Version`, always `x-cp-surface: workspace`. The workspace makes conveyance convenient. It does not make it publication, and nothing it serves can be cached, matched or selected as a version. The only road to a contract runs through canon, where §5.3's guarantees attach.
2. *Content that varies by reader.* A workspace that served one draft to Realm A and another to Realm B would be a Profile conditioned on the Realm, with no line in the document to show it. Invariant: one unpublished form per name, the same bytes to every reader, no credential on reads, no `Vary` on anything identity-bearing, no per-partner drafts. Open reads are a non-capture guarantee, not only a convenience — and if private drafts are ever wanted, that is a new design question to be argued against §5.3, not a flag to be set.
3. *A doctored mirror.* The host could serve a partner a published version that says something else. That is the fork of §20.2, and the workspace adds no new way to commit it: it has no path to `profile` or `profile_version`, the Registry surface's machine representations stay byte-identical to canon's, the anchor polices the mirror as before, and `verify-journal --resolve` against the host still proves that what is served hashes to what the act recorded.
4. *The host as a gate.* A forwarder that could refuse or alter an organization's acts would make the organization's authors dependent on the host. Forwarding is not yet built; when it is, it relays and never decides, canon is always reachable directly, and a member's authority at canon never passes through the host.
5. *Content that names the host.* A draft whose Channels or Defaults point at the host, or at any party's governance, conditions its own enactment. That is a matter of the document, not of where it is held, and §16's `profile.non-capture` check already says so; the client's save path runs lint before it saves. The workspace itself refuses no content, because the unpublished form is not a contract and a workspace that refused on taste would be the house style §16 was written to keep out.
6. *On the Governor's side.* A Realm whose rules say "we bind Unpublished Profiles conveyed to us" has a rule of the first kind (spec §6.3); a Realm whose rules say "only Profiles from Padi's workspace" has a Profile restriction, which must be declared before admission, applied to every Node alike and named in every refusal (spec §5.3). The workspace is one conveyance among others and creates no new ground of refusal. The one dependence it does create — the `:unpublished` reference resolves at exactly one host, the author's — is the dependence the specification accepts for unpublished content, and a Governor that operates from the copy it took in (spec §7.4), which the `ETag` lets it pin, has no runtime dependence on the host at all.

**What it is not.** Not a Registry surface: nothing it serves is a version, and nothing it holds is in the feed or under the chain. Not a private drafts service: everything it holds, anyone who can reach it can read. Not a place for other organizations' names. Not a substitute for publication, and not a development namespace — the draft lives at the name its versions will occupy, or under `test`, which is the reason §24 has none. Not Padi's: the same image, the same settings and the same runbook for every organization, and `cp.padi.io` is simply the first host that runs it.

**Conformance, stated for a host running both.** The §22 checklist row "SHALL NOT hold, serve, or answer for the content of an unpublished Profile" is met by the Registry surface, whose machine representations are byte-identical to canon's whether or not a workspace is beside it. The workspace beside it is the author's, is marked as such on every answer, and never appears in `/distribution/*`. A party checking the host checks the Registry surface with the same verifier as any other instance, and can tell a workspace answer from a Registry answer by the header alone.

**Freshness: the one refusal a stale mirror can invent.** A name is registered at the authoritative store, and this host learns of it on its next sync — up to a sync interval later. An author who has just claimed a name and turns to save its form would be told the name is not registered, which is false, and told it by the host that is merely behind. So `not-registered` is the one refusal worth spending an upstream call to be sure of: on a save, the workspace catches up once (the ordinary follower path of §20.1, hash checks and all, rate-limited) and asks again before refusing. Every other refusal here rests on facts that cannot go stale in the direction that matters — a name held by another organization, a malformed name, a `test.*` form where they are not admitted — so none of them spends a call. *A host must not report its own lag as a fact about the namespace.*

**Forwarding (built 21 September 2026).** §4.4 has an instance answer a write with `405` and the authoritative host's URL. An instance configured with `FORWARD_WRITES=true` relays it instead: the caller's request, with the caller's own credential, to the authoritative host, and the answer back verbatim, with `x-cp-forwarded-to` naming where it went. It exists so that an organization has one URL for its tools — drafts and acts at the same host — and it matters most inside a security boundary, where the internal host is deliberately the only thing that talks to canon.

*It relays; it does not decide,* and each clause of that is enforced rather than promised. The host holds no canon credential, so it has nothing of its own to send and can act for nobody; what it relays is the bearer the caller presented, and canon checks scope and the seam and names the caller's principal in the journal exactly as it always does. It refuses nothing of its own: every answer is the upstream's status, body and headers, unread — a forwarder that could refuse an act canon would accept would make an organization's authors dependent on their host, which is the §5.3 capture this design exists to avoid (ground 4 above). It keeps nothing: the credential is read from one header and written to one, never logged (asserted in test against the host's own log stream) and never stored. And canon is always reachable directly, which is what makes those three checkable rather than trusted.

Only a Profile path is relayed — a first path segment containing a dot, §4.4's one routing rule — which excludes `/operator/*` (the operator's own plane), `/auth/*` and `/account` (which belong to canon's own origin, where the session cookie is), and every other dotless path; those still get §4.4's answer. `:unpublished` never reaches the forwarder: it is the workspace's. When the authoritative host cannot be reached, the answer is `502` naming it and saying plainly that nothing here refused the act and nothing here recorded it, and that the caller should check at canon whether it had already taken effect before retrying anything irreversible — because a relay that times out cannot know which side of an irreversible act it stopped on.

**The clients.** The MCP server (`src/mcp/server.ts`) gains `get_unpublished` and `save_unpublished`, the only tools there that carry the workspace credential and the only ones that reach `CP_WORKSPACE_URL` — which defaults to `CP_REGISTRY_URL`, so a forwarding host is one URL for everything and a non-forwarding one is two. `get_unpublished` hands back the `ETag` and says to pass it as `if_match`; `save_unpublished` says in its own description that it is not publication and creates no version. `register_name` gains an optional document, and makes the two calls in order — registration at canon, then the save — reporting each separately and rolling back neither, because a registration is a public act that happened. There is still no combined act on any server.

**Still to come:** the cut-over of `cp.padi.io` from the 0.11.0 server, and Q14's second form of the credential.

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
| SHALL NOT hold, serve, or answer for the content of an unpublished Profile; SHALL answer that a name is registered and since when | §12.1 has no content columns (migration 6); `:unpublished` never resolves (§13.3, §19); `GET /<name>/registration`. *Met by the Registry surface of every host; a co-hosted workspace (§20.3) is the author's, marked on every answer, never in the feed, and its table is outside canon's schema* |
| SHALL NOT delete or alter a published version | §12.2 triggers; no operator endpoint exists (§9.2) |
| Permits Header change only for lifecycle and stewardship fields | §12.2 columns; `PATCH …/header` restricted to Owner and Website; the answer carries the current values (§18 overlay) |
| Serves without regard to the identity of the party presenting a name | §19 |
| SHALL register any name meeting spec §7.2 and §7.3; refuses only on stated grounds | §14 — owner policy is not a Registry ground |
| Same name and version never answered with differing content | §12.2 `served_bytes` + `content_hash` |
| Answers such that independent parties can detect whether copies agree | `Content-Digest` + the signed anchor, built 14 Sept (§4.3, §19, §20.2); `verify-journal --anchor` is the check, and needs no credential |

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
6. **Seam isolation** — Part Two serves reads with Part One unavailable and every write waits with a structured 503; governance state never appears in a resolution response.
7. **Scope containment** — a credential without `publish` cannot publish, without `deprecate` cannot deprecate, without `operator` cannot perform an operator act, under any endpoint or parameter combination; each preparatory scope covers exactly its act; and `dry_run=true` provably writes nothing.
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
| **1 — Conforming Registry** *(opened 11 Sept 2026)* | Parts Two and Three in full against the §22 checklist: registration with authorization, ~~Draft with the disclosure trapdoor~~ *(withdrawn by the 8 Sept revision, §24.5)*, publication with integer versions and additivity, per-version deprecation, **distribution feed and local instances (§20.1 — built first)**, audit chain. **Self-service identity (§15.3 — built 12 Sept): people sign in with Google or GitHub and mint their own tokens; the operator's act per author is one `member add`.** **Contract lint (§16.1 — built 14 Sept): advisory, never a refusal ground, on the API, in the MCP server and attached to every rehearsal.** **The signed anchor (§20.2 — built 14 Sept): the key on the operator's machine, a weekly floor, published in two places, checked by followers and by `verify-journal --anchor` — the last unmet row of §22 is met.** **Q10 settled 16 Sept: the 2026 revision is published, so the §22 checklist can be checked by someone other than its authors.** **The workspace beside an instance (§20.3 — built 21 Sept): an organization's unpublished forms on its own host, for research, development and testing inside a boundary or in public.** Still open in this phase: the first outside author's first publication. |
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
7. **Two rules in §5 and §8.3 have no mechanism — surfaced while building the spine.** (a) §5 says membership "is itself authorization to act under the Prefix in Part Two, **unless the owner has narrowed it with scopes**," but §6.4's `authorization_record` grants scope to *another organization* and has no form that narrows a member of the holder. As written, membership is unconditional and the narrowing clause is unimplementable. Either §6.4 gains an intra-organization form, or §5 drops the clause. (b) ~~§8.3 says scopes "are not re-delegable at v1," but nothing records *which organization granted* a record~~ **Settled 12 Sept 2026:** `granted_by_org_id` (migration 9); the seam honours a grant only from the allocation's current holder, which enforces no-re-delegation and revoke-on-transfer with one comparison. (a) remains open. Both are load-bearing the moment a standards body arrives, which is also what Q6 is about.
8. **Allocation term expiry is recorded and unenforced.** `allocation.expires_at` exists (§6.3) and nothing reads it: the redemption transition of §7.2 is what moves `status`, and that is Phase 2 work. Until then an allocation whose term lapsed years ago still authorizes writes. Harmless while the operator holds nearly everything; a real gap the moment §8.2 renewal is announced to holders.
9. **§8.1 has one verification method, and it excludes real claimants.** Domain control via DNS TXT or `/.well-known/` proves control of a *web identity*, which two of the seven grandfathered claimants (`ibb`, `skycentrics`) simply do not have — their recorded websites are Google Docs. A second method is needed before Phase 2, and the obvious candidate is an operator attestation: a steward records direct contact with the claimant as evidence, with rationale, in place of an automated challenge. That trades a machine-checkable proof for a human one, so it needs the two-steward discipline of §5 and a published record — which is also why it interacts with Q4, who reviews the reviewers.
10. **~~The 2026 revision is in draft, and the public repository still carries the 2022 one.~~ Settled 16 September 2026: the revision is published.** [github.com/CNSCP/specification](https://github.com/CNSCP/specification) now carries the 2026 revision on `main`, with the December 2022 text kept unchanged under `2022/` as history. This design's normative anchor is repinned to it (`072d4435…be6c0e`, 136,899 bytes), and the pinned bytes are served publicly, so the pin itself is checkable by anyone.

    Two things follow, and they are the two this entry existed to name. **§22's conformance checklist can now be checked by someone other than its authors** — its rows cite sections that resolve in a document a reader can open, which is what spec §9.6 ("How conformance is observed") and §7.4 (third parties running local instances) always assumed. And **building from the repository no longer produces an incompatible contract**: what was there until now emitted `"Status": "Active"`, put `"Source": "provider"` on each Property, and had no Propagate attribute at all. That was never hypothetical — `spec2026.ts` refuses `"Status": "Active"` precisely so a 2022-shaped document cannot be imported as though it carried 2026 lifecycle state, and there is a test for it. Those refusals stay: the 2022 text still exists, still describes a real deployed shape, and a document in that shape must still be refused rather than silently reinterpreted.

    What remains is not an oversight but the ordinary condition of a draft: the published revision is a **working draft**, its Appendix C lists what its editors know to be unsettled, and it will revise. So the hash pin stays exactly as it is. Publication turned "no one outside can check this" into "anyone can check this"; it did not turn a moving document into a fixed one. *(Noted while building, and now a fact about a public document: the 2022 draft's worked example in its §2.4.1 is `cp:xyz.ics:2`, with the same Owner and `www.example.com` website as the live `xyz.ics` record, and its §3.3–§3.4 examples use `test.abc` — so both Prefixes withheld under §10.2 are the specification's own sample data, which is a stronger reason for those rulings than the ones recorded there.)*

11. ~~**What Phase 0 imports, given that none of it conforms.**~~ **Settled 31 Aug 2026; see §10.4.** Real Connections bind against the deployed records, so they must keep resolving through the import. They are imported as published versions, marked grandfathered, with their §9.4 shortfalls recorded and published rather than filled. Nothing is fabricated. The `Sample` question is settled with it: spec §6.4's "this specification takes no view of them" makes an absent Sample a formatting matter, not a conformance failure — so all 303 deployed Properties clear that bar.
12. **~~The signed anchor is not yet published.~~ Built 14 Sept 2026 — see §20.2.** *(The original statement is kept below for the record.)* §4.3 has the operator periodically sign the chain head and §20 has instances verify against it; as built, `/distribution/status` reports `anchor: null` and an instance verifies content hashes and chain integrity only. What the anchor adds is protection against an authoritative host that serves *different* consistent chains to different parties — a fork — which hashes alone cannot detect. Needs a signing key held outside the cluster, a publication place (the `.well-known` path is reserved for it), and a rotation story. Small; deliberately not improvised.

13. **Should the specification standardize the Registry's HTTP interface, and reserve the words it needs? — for OSTERA.** The spec defines names and Profiles and requires (§7.4) that third parties can run local instances, but says nothing about the URL a Profile resolves at, the path a feed lives on, or the words a host's own paths take out of the namespace. This design supplies all three as convention (§4.4, §19, §20.1, §3.2). Surfaced 13 Sept 2026 when `/account` and `/auth` (§15.3) had to be withheld as Prefixes a day after the paths existed. Two readings: (a) the interface is an implementation detail, so reserved words stay operator policy, published with reasons, and only the spec's own vocabulary (`cp`, `cns`, `realm`) joins `example` and `test`; (b) the interface is part of the standard — a normative appendix with the resolution URL form, the feed paths, and a short reserved-word list (`account`, `auth`, `profiles`, `distribution`, `health`, `operator`, `console`, `assets`, `well-known`) that only grows by revision — so a follower can follow any instance and a person finds the same paths at every Registry. Anto's inclination is (b), for consistency across Registries; the working-group question is whether the specification wants to own an HTTP surface at all. Carried to OSTERA with the next revision.
14. **Workspace credentials by introspection.** The environment credential is the workspace's first form (§20.3): one token per label, on the host, reach fixed by `WORKSPACE_ORGS`. The second is a route at canon that answers who a bearer is and which organizations they belong to, after which a workspace applies the seam's membership rule from the allocation facts it mirrors and needs no credential of its own — and can tell an author from an assistant, which the first form cannot. A third, for a host inside a boundary that already has single sign-on in front of everything, reads the identity a trusted gateway asserts. One function, `mayWriteWorkspace`, so each is a drop-in. Wanted by the second organization to run a workspace; not before.

---

*Design document for the Connection Profile Registry. The [CNS/CP specification](https://github.com/CNSCP/specification) is authoritative throughout; where this document conflicts with it, this document is wrong. [ARETE.md](https://raw.githubusercontent.com/project-arete/sdk/main/ARETE.md) remains authoritative for SDK-facing conventions.*
