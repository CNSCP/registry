# Releasing to cp.cnscp.io

Self-serve, from a Mac with GKE access (project `padi-80910`, cluster `padi-prod`,
namespace `cp-registry`).

1. `git push origin main`. CI runs the suite (including the real-PG16 job) and
   publishes `ghcr.io/cnscp/registry:latest`.
2. **Wait for the publish job to finish** (Actions tab; ~90 s). The SHA-tagged image does
   not exist until it has.
3. **If the release changes the Deployment manifest** (new env, a new secret reference):
   `kubectl apply -f deploy/k8s/20-registry.yaml` — and make sure any secret it references
   exists in `cp-registry` first (`kubectl -n cp-registry get secret <name>`), or the new
   pods sit in `CreateContainerConfigError` while the old ones keep serving (12 Sept).
   The manifest pins `:latest`, so always follow the apply with step 4's `set image`.
4. Roll out **by commit tag, not by restart.** CI tags every image with the full commit
   SHA as well as `:latest`; naming the SHA makes the rollout deterministic, where a
   `rollout restart` re-pulls `:latest` and quietly keeps the old image if the publish job
   has not finished (it did exactly that on 11 Sept, twice):
   ```sh
   kubectl -n cp-registry set image deployment/registry registry=ghcr.io/cnscp/registry:$(git rev-parse HEAD)
   kubectl -n cp-registry rollout status deployment/registry
   ```
5. **If the release adds a migration, run it now — after the new image is up:**
   ```sh
   kubectl -n cp-registry exec deploy/registry -- npm run migrate up
   ```
   The command runs inside a pod of the running Deployment, and the migration files
   live in the image: run it before the rollout and it executes in the *old* pod, finds
   nothing new, and reports "complete" (12 Sept, migration 11 — the first sign-in
   answered `relation "user_identity" does not exist`). The bootstrap Job ran migrations
   once, at bootstrap; a rollout only swaps code. Between the rollout and the migration
   the new code runs against the old schema, so keep migrations additive and keep the
   window short; the 11 Sept `500` on `/distribution/journal` was this window left open.
6. Check: `curl -s https://cp.cnscp.io/health`, and
   `npm run verify-journal -- https://cp.cnscp.io --resolve` should end in `intact`.

Then on the Mac: `npm run migrate up` against the local `cp_registry`, and relaunch the
local servers (`Start_registry.command`; if it refuses quietly, stale processes hold
8080/8082 — `kill $(lsof -t -iTCP:8080 -iTCP:8082 -sTCP:LISTEN)` first).

Migration history that needed step 3: migration 7 (`1730000007000_distribution`, 11 Sept —
learned the hard way), migration 8 (`1730000008000_released-names-are-free`, 11 Sept).
Migration 10 (`1730000010000_credentials`, 12 Sept) likewise — and after it, mint the real
tokens per `deploy/CREDENTIALS.md` before removing `CP_AUTHOR_*` from the Deployment.
Migration 11 (`1730000011000_identity-and-sessions`, 12 Sept) is where the order above was
learned: apply the manifest (it added `envFrom: registry-oauth` and `CP_PUBLIC_ORIGIN`),
`set image`, *then* migrate. The `registry-oauth` secret exists since 12 Sept; its values
are also in the Mac `.env`, so it can be rebuilt from there
(`grep -E '^CP_(OAUTH_|SESSION_SECRET)' .env > ~/registry-oauth.env`, then
`kubectl -n cp-registry create secret generic registry-oauth --from-env-file=… --dry-run=client -o yaml | kubectl apply -f -`,
then `rollout restart`, which is safe once the image is pinned by SHA). One more lesson from
the same evening: copy client ids and secrets from the provider's page, never retype them
from a screenshot — `5Ow` and `50w` are the same picture.

## Backups, and the one thing they don't cover

`deploy/k8s/40-backup.yaml` has run since Phase 0: a CronJob at 03:15 UTC takes a
`pg_dump` of `cp_registry`, gzips it onto the `registry-backups` PVC, and deletes dumps
older than 30 days. The whole dataset is kilobytes.

```sh
kubectl -n cp-registry get cronjob registry-backup
kubectl -n cp-registry run dump-ls --rm -it --restart=Never --image=postgres:16 \
  --overrides='{"spec":{"containers":[{"name":"dump-ls","image":"postgres:16","command":["ls","-la","/backups"],"volumeMounts":[{"name":"b","mountPath":"/backups"}]}],"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"registry-backups"}}]}}'
```

**To restore**, load a dump into an empty database and then let the audit chain check
itself — which is the part a database restore normally cannot offer:

```sh
gunzip -c cp_registry-<stamp>.sql.gz | psql -d cp_registry_restored
psql -d cp_registry_restored -c 'SELECT * FROM audit_chain_verify(1)'
```

Zero rows means the history is exactly what was written (§4.3): not merely that the
restore succeeded, but that no event was altered, dropped or reordered anywhere in it.
Any row names the first break. Restore into a *new* database and compare before pointing
anything at it; never restore over the live one to "see if it works".

What this does not cover: the dumps live on a PVC in the same cluster and the same GCP
project as the database they protect, so they survive a bad migration, a dropped table and
a lost pod, but not the loss of the cluster or the project. Until the move to
`cnscp-registry` and a managed Postgres — when this is set up properly — take a copy off
the cluster from time to time, which is one command:

```sh
kubectl -n cp-registry exec deploy/registry -- sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h postgres -U $POSTGRES_USER -d cp_registry | gzip' \
  > ~/Registrar/backups/cp_registry-$(date +%Y%m%d).sql.gz
```

A backup nobody has restored is a hypothesis. Restoring one into a throwaway local
Postgres and seeing `audit_chain_verify` return nothing takes half an hour and settles it.

## The weekly anchor (§20.2)

Migration 12 (`1730000012000_anchor`) adds `anchor_key` and `anchor`; it changes no
existing table, so the usual order applies — apply the manifest if it changed, `set image`,
*then* `migrate up`.

First time only, on the Mac:

```sh
npm run anchor -- --new-key cp-anchor-2026-09
```

That writes `~/.cp-registry/anchor-key.pem` (mode 0600) and prints the public key and a
fingerprint. **The private key never leaves that machine** — not into a chat, an email, a
screenshot or a log; nothing in the Registry reads one, and nothing needs to. Publish the
fingerprint in `REGISTRY-DESIGN.md` §20.2, the README and on cnscp.io, because the first key
is the one thing the mechanism cannot vouch for. Then register the public half:

```sh
kubectl -n cp-registry exec deploy/registry -- npm run operator -- \
  anchor trust --key-id cp-anchor-2026-09 --public-key <base64url> --by anto@padi.io
```

Then weekly, and after anything irreversible (a publication, a deprecation, an allocation,
a transfer):

```sh
CP_ANCHOR_KEY_ID=cp-anchor-2026-09 npm run anchor -- --emit /tmp/anchor.json
kubectl -n cp-registry exec -i deploy/registry -- npm run operator -- \
  anchor publish --by anto@padi.io < /tmp/anchor.json
```

and commit the same document to the public anchor mirror. Check it:

```sh
curl -s https://cp.cnscp.io/.well-known/cp-anchor
npm run verify-journal -- https://cp.cnscp.io --anchor cp-anchor-2026-09
```

The last line should say `anchor verified at seq N`. `FORK` means the journal served does
not match the head that was signed — stop and keep both documents; that is the evidence.
