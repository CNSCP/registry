# Releasing to cp.cnscp.io

Self-serve, from a Mac with GKE access (project `padi-80910`, cluster `padi-prod`,
namespace `cp-registry`).

1. `git push origin main`. CI runs the suite (including the real-PG16 job) and
   publishes `ghcr.io/cnscp/registry:latest`.
2. **Wait for the publish job to finish** (Actions tab; ~90 s). The SHA-tagged image does
   not exist until it has.
3. **If the release adds a migration, run it on the cluster database first:**
   ```sh
   kubectl -n cp-registry exec deploy/registry -- npm run migrate up
   ```
   The bootstrap Job ran migrations once, at bootstrap; a rollout only swaps code.
   Skipping this is how the Phase 1 rollout on 11 Sept 2026 answered `500` on
   `/distribution/journal` — and, worse, would have failed every write act, because
   `record()` writes a column the database did not yet have. Migrations are additive
   and the previous image tolerates them, so running the migration before the rollout
   is always safe; the reverse is not.
4. Roll out **by commit tag, not by restart.** CI tags every image with the full commit
   SHA as well as `:latest`; naming the SHA makes the rollout deterministic, where a
   `rollout restart` re-pulls `:latest` and quietly keeps the old image if the publish job
   has not finished (it did exactly that on 11 Sept, twice):
   ```sh
   kubectl -n cp-registry set image deployment/registry registry=ghcr.io/cnscp/registry:$(git rev-parse HEAD)
   kubectl -n cp-registry rollout status deployment/registry
   ```
5. Check: `curl -s https://cp.cnscp.io/health`, and
   `npm run verify-journal -- https://cp.cnscp.io --resolve` should end in `intact`.

Then on the Mac: `npm run migrate up` against the local `cp_registry`, and relaunch the
local servers (`Start_registry.command`; if it refuses quietly, stale processes hold
8080/8082 — `kill $(lsof -t -iTCP:8080 -iTCP:8082 -sTCP:LISTEN)` first).

Migration history that needed step 3: migration 7 (`1730000007000_distribution`, 11 Sept —
learned the hard way), migration 8 (`1730000008000_released-names-are-free`, 11 Sept).
Migration 10 (`1730000010000_credentials`, 12 Sept) likewise — and after it, mint the real
tokens per `deploy/CREDENTIALS.md` before removing `CP_AUTHOR_*` from the Deployment.
Migration 11 (`1730000011000_identity-and-sessions`, 12 Sept) likewise; the same release
adds `envFrom: registry-oauth` and `CP_PUBLIC_ORIGIN` to the Deployment (`kubectl apply -f
deploy/k8s/20-registry.yaml` before the `set image`), so the `registry-oauth` secret must
exist first — it does since 12 Sept. After the rollout, sign in at
https://cp.cnscp.io/account, mint your own tokens there, and then retire `CP_AUTHOR_*`.
