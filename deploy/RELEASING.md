# Releasing to cp.cnscp.io

Self-serve, from a Mac with GKE access (project `padi-80910`, cluster `padi-prod`,
namespace `cp-registry`).

1. `git push origin main`. CI runs the suite (including the real-PG16 job) and
   publishes `ghcr.io/cnscp/registry:latest`.
2. **Wait for the publish job to finish.** A rollout started before it pulls the
   previous `:latest` silently and looks like a deploy that changed nothing.
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
4. `kubectl -n cp-registry rollout restart deployment/registry` and
   `kubectl -n cp-registry rollout status deployment/registry`.
5. Check: `curl -s https://cp.cnscp.io/health`, and
   `npm run verify-journal -- https://cp.cnscp.io --resolve` should end in `intact`.

Then on the Mac: `npm run migrate up` against the local `cp_registry`, and relaunch the
local servers (`Start_registry.command`; if it refuses quietly, stale processes hold
8080/8082 — `kill $(lsof -t -iTCP:8080 -iTCP:8082 -sTCP:LISTEN)` first).
