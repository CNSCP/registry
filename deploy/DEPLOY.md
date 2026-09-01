# Making it canon — deploying to cp.cnscp.io

The runbook for standing the Registry up on Padi's Kubernetes cluster, next to
the existing `cp.padi.io` service. Design references are to
[`REGISTRY-DESIGN.md`](../../REGISTRY-DESIGN.md).

**The parallel-running rule** (§10.4, spec §7.1's one-namespace premise): from
the moment `cp.cnscp.io` is live, it is the **only write surface**. Nothing
writes to `cp.padi.io` — confirmed already true — so the old server serves its
frozen copies without drift while the fleet migrates. The `/profiles/` alias
here serves the legacy shape by default (§19.2), so pointing old SDKs at the
new host later requires no SDK changes.

## 0. One-time: repo and image

```sh
# From the registry/ directory. Public repo — spec §7.4 wants local instances
# to be possible, and public code is what makes that real. Pick the license to
# match the cnscp org convention before pushing.
git init && git add -A && git commit -m "Connection Profile Registry — Phase 0"
gh repo create cnscp/registry --public --source . --push
```

CI runs the 332 tests, then migrations + seed + import against **real
PostgreSQL 16** (closing the wasm-PG18 gap), and on green pushes
`ghcr.io/cnscp/registry:latest`. If the cnscp org's ghcr packages default to
private, make this one public (Packages → registry → settings) or add an
imagePullSecret to the manifests.

## 1. Namespace and database secret

```sh
kubectl create namespace cp-registry

kubectl -n cp-registry create secret generic registry-db \
  --from-literal=POSTGRES_USER=registry \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=POSTGRES_DB=cp_registry
```

## 2. Postgres

```sh
kubectl apply -f deploy/k8s/10-postgres.yaml
kubectl -n cp-registry rollout status statefulset/postgres
```

## 3. Bootstrap — migrations, seed, identity, import

```sh
kubectl apply -f deploy/k8s/30-bootstrap-job.yaml
kubectl -n cp-registry logs -f job/registry-bootstrap
```

Expect, in order: six migrations, `Bootstrap: 30 allocations created`, a line
`CP_AUTHOR_USER_ID=<uuid>` — **copy that uuid** — and
`Imported: 69 names registered, 69 versions published`.

The Job is idempotent; re-running it changes nothing and says so.

## 4. The authoring credential

```sh
kubectl -n cp-registry create secret generic registry-auth \
  --from-literal=CP_AUTHOR_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=CP_AUTHOR_USER_ID="<the uuid from step 3>"
```

Note: this is a **different token** from your Mac's. The local Registry and
canon are separate instances with separate credentials; your Claude config can
hold both (an `mcpServers` entry per instance).

## 5. The Registry itself

Check the two annotations in `20-registry.yaml` first: `ingressClassName:
nginx` and `cert-manager.io/cluster-issuer: letsencrypt-prod` should match
whatever fronts `cp.padi.io` today.

```sh
kubectl apply -f deploy/k8s/20-registry.yaml
kubectl -n cp-registry rollout status deployment/registry
```

## 6. DNS

Add `cp.cnscp.io` → your cluster's ingress IP (same record shape as
`cp.padi.io`). cert-manager then provisions TLS on its own; give it a minute.

## 7. Verify canon

```sh
curl https://cp.cnscp.io/health
curl https://cp.cnscp.io/padi.tstat.basic:1            # 2026 shape
curl -H "Accept: application/json" \
     https://cp.cnscp.io/profiles/padi.tstat.basic:1    # legacy shape, fleet-compatible
curl -sI https://cp.cnscp.io/padi.tstat.basic:1 | grep -i cache-control
#   → public, max-age=31536000, immutable   (§18)
```

And open `https://cp.cnscp.io/padi` in a browser.

## 8. Backups

```sh
kubectl apply -f deploy/k8s/40-backup.yaml
```

Nightly `pg_dump` to a PVC, 30 days retained. After any restore,
`SELECT * FROM audit_chain_verify(1)` returning zero rows proves the restored
history is exactly what was written (§4.3).

## What this deployment deliberately is not

- **No `tlp.cnscp.io` yet.** Part One's console and workflows are Phase 2; the
  spine runs inside the same process and the seam never leaves the pod.
- **No writes ever reach `cp.padi.io`.** Canon has one write surface.
- **No CDN yet.** §18's headers make versioned fetches infinitely cacheable, so
  a CDN in front is a config change whenever traffic justifies it.

## Cutover, when you are ready (not now)

Point `cp.padi.io` at this service (CNAME or ingress rule serving both hosts).
The `/profiles/` alias answers in the legacy shape, so the deployed fleet
migrates without touching a single SDK. Retire the 0.11.0 server after
watching its traffic go quiet.
