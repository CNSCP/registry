# CP Registry — infra handoff

For Andy Duss. This is the operational contract for deploying the Connection
Profile Registry to Padi's cluster as `cp.cnscp.io`, alongside (not touching)
the existing `cp.padi.io` service. The build flow is yours to own — what's in
`.github/workflows/ci.yml` is a working starting point, not a mandate. The
step-by-step runbook is [`DEPLOY.md`](DEPLOY.md); this document is the contract
and the reasoning.

Contact for anything namespace- or policy-shaped: Anto (anto@padi.io). The
design document is `REGISTRY-DESIGN.md` at the repo root; section references
below (§) point into it.

## What this service is

A registry of Connection Profiles — small, immutable JSON contracts that
systems resolve at connection time. Operationally it is a tiny read-mostly
HTTP service in front of Postgres: the whole dataset is kilobytes, writes are
rare and administrative, reads are aggressively cacheable by design. It
replaces the older `cp.padi.io` profiles server (0.11.0), which stays running
untouched during the transition and receives no writes.

## Runtime contract

| | |
|---|---|
| Image | `ghcr.io/cnscp/registry` (built by CI; Dockerfile at repo root) |
| Process | `node --experimental-strip-types src/authoritative-server.ts` (image CMD) |
| Port | `8082` (HTTP; TLS terminates at your ingress) |
| Health | `GET /health` → `200 {"ok":true}` — readiness and liveness |
| State | Stateless; all state in Postgres. Replicas safe (writes serialize on row locks). 2 suggested. |
| Resources | Tiny. Suggested requests `50m / 128Mi`, limit `256Mi`. Postgres similar. |
| Database | PostgreSQL **16** (15+ fine; ≥13 required). One DB, `cp_registry`. |
| Shutdown | No special handling; in-flight transactions commit or roll back cleanly. |

### Environment

| Variable | Kind | Meaning |
|---|---|---|
| `DATABASE_URL` | secret | Standard Postgres URL |
| `CP_AUTHOR_TOKEN` | secret | Bearer token gating all write verbs (≥32 chars) |
| `CP_AUTHOR_USER_ID` | secret | UUID printed by the bootstrap Job (see ordering note) |
| `CP_PORT` | config | `8082` |
| `BIND_HOST` | config | `0.0.0.0` in-cluster |
| `CP_AUTHOR_KIND` / `CP_AUTHOR_PRINCIPAL` / `CP_AUTHOR_SCOPES` | config | Audit identity of the write credential; values in the manifest |
| `RENDER_HTML` | config | Optional; `false` disables the human-readable pages |

## What the repo provides (yours to adapt)

- `Dockerfile` — no build step by design: the container runs the same
  TypeScript the test suite runs, via Node 22 type-stripping. If you'd rather
  build/distroless it, nothing prevents that.
- `.github/workflows/ci.yml` — tests (332, self-contained), a second job
  running migrations + seed + import against real Postgres 16, then
  build-and-push to ghcr on green main. Replace with your flow at will; the
  **PG16 job is the part worth keeping** in whatever you build.
- `deploy/k8s/*.yaml` — StatefulSet Postgres, Deployment, Ingress
  (nginx + cert-manager assumed — fix the class and issuer to match the
  cluster), bootstrap Job, backup CronJob. Starting points, not gospel.

## The bootstrap, and its one ordering trap

`deploy/k8s/30-bootstrap-job.yaml` runs migrations → seed → author identity →
import, all idempotent. **The Job prints `CP_AUTHOR_USER_ID=<uuid>` in its
logs, and that uuid must go into the `registry-auth` secret before the
Deployment rolls out.** First deploy is therefore: Postgres → Job → read logs →
create secret → Deployment. Re-running the Job any time is a no-op that says so.

Expected log landmarks: `Migrations complete!` · `Bootstrap: 30 allocations
created` · `CP_AUTHOR_USER_ID=…` · `Imported: 69 names registered, 69 versions
published`.

## Invariants infra must never break

These come from the specification the service implements, not from preference:

1. **Resolution is public and unauthenticated by design.** Do not put auth,
   bot-blocking, or geo rules in front of `GET` paths — the spec requires
   answers "without regard to the identity of the party asking" (§19, spec §9.3).
2. **Nothing may edit or delete a published version — including DBAs.**
   Database triggers enforce it; treat any need to bypass them as a design
   escalation to Anto, not an operational fix (§12.2).
3. **One write surface.** `cp.cnscp.io` is canon; nothing writes to
   `cp.padi.io` ever again. Parallel serving is safe only because of this.
4. **Backups are the disaster story** — the data is irreplaceable contract
   history. Nightly `pg_dump` CronJob provided; after any restore,
   `SELECT * FROM audit_chain_verify(1);` returning zero rows proves integrity (§4.3).
5. **Caching is load-bearing, in both directions.** Versioned fetches
   (`/name:1`) are `immutable, max-age=1y` — cache freely, CDN welcome.
   Unversioned fetches (`/name`) are `no-cache` **on purpose**: they carry
   deprecation state. A cache layer that overrides that header breaks the
   protocol (§18).

## Yours to decide

Ingress class and certificate issuer · storage classes and sizes · whether the
ghcr package is public or pulled via secret · CD tooling (Argo/Flux/plain
applies — nothing in the app cares) · resource tuning · whether Postgres stays
the provided StatefulSet or moves to whatever Padi prefers (the app sees only
`DATABASE_URL`).

DNS: one record, `cp.cnscp.io` → the ingress, same shape as `cp.padi.io`.
`tlp.cnscp.io` is a later phase; nothing to provision now.

## Verifying a deploy

```sh
curl https://cp.cnscp.io/health
curl https://cp.cnscp.io/padi.tstat.basic:1                            # new-format JSON
curl -H "Accept: application/json" https://cp.cnscp.io/profiles/padi.tstat.basic:1   # legacy format
curl -sI https://cp.cnscp.io/padi.tstat.basic:1 | grep -i cache-control  # …immutable
```

And `https://cp.cnscp.io/padi` in a browser should render an allocation page
listing ~30 names.
