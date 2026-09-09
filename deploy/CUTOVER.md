# Cutover: the Mac database becomes cp.cnscp.io

Anto's ruling (9 Sept): `cp.cnscp.io` starts from a dump of the development
database, not the fixture bootstrap. The Mac database holds real post-import
acts — registrations, publications, and the audit chain that proves them —
and canon means that history carries.

Order matters; the whole sequence is: dump → infra up → restore → Job →
secret → Deployment → verify.

## 1. On Anto's Mac — produce the dump

```sh
cd ~/Registrar/registry
# Prove the history is intact BEFORE it becomes canon (zero rows = intact):
psql cp_registry -c "SELECT * FROM audit_chain_verify(1);"

pg_dump --format=custom --no-owner --no-privileges cp_registry \
  > cp_registry_$(date +%Y%m%d).dump
```

Hand the file to Andy by whatever channel Padi uses for secrets-adjacent
material. It is not secret, but it is canon-to-be: treat it as write-once.

## 2. On the cluster — restore BEFORE the Deployment exists

Postgres StatefulSet up (`10-postgres.yaml`), then:

```sh
kubectl cp cp_registry_YYYYMMDD.dump <postgres-pod>:/tmp/
kubectl exec <postgres-pod> -- \
  pg_restore --no-owner --no-privileges -d cp_registry /tmp/cp_registry_YYYYMMDD.dump
```

## 3. Run the bootstrap Job anyway

Every step is idempotent against restored data: migrations report nothing to
do (or apply any newer than the dump), seed and import skip what exists, and
the identity step prints the **existing** author id from the restored data:

```
CP_AUTHOR_USER_ID=<uuid>
```

That uuid goes in the secret. Do not invent one.

## 4. The auth secret — fresh token, minted in place

The development token does not go to production. Mint the production token at
secret-creation time, so it exists nowhere else:

```sh
kubectl create secret generic registry-auth \
  --from-literal=CP_AUTHOR_TOKEN=$(openssl rand -hex 32) \
  --from-literal=CP_AUTHOR_USER_ID=<uuid from the Job log>
```

Anto retrieves it when he needs it (`kubectl get secret registry-auth -o
jsonpath='{.data.CP_AUTHOR_TOKEN}' | base64 -d`); it never travels by chat or
email.

## 5. Deployment, ingress, DNS

As in [`DEPLOY.md`](DEPLOY.md). Image: `ghcr.io/cnscp/registry` built from
commit `3810e33` or later.

## 6. Verify canon

```sh
kubectl exec <postgres-pod> -- psql -U <user> cp_registry \
  -c "SELECT * FROM audit_chain_verify(1);"        # zero rows: history intact
curl https://cp.cnscp.io/                          # index: 30 allocations (31 after a seed re-run)
curl https://cp.cnscp.io/padi.lighting/registration  # the restored act: registered, no versions
curl -sI https://cp.cnscp.io/padi.tstat.basic:1 | grep -i cache-control   # immutable
```

The `padi.lighting` check is the point of the dump: a name registered on the
Mac on 9 Sept, answering from the cluster with its original registration date.

## 7. After cutover

- `cp.cnscp.io` is the ONLY write surface, effective immediately (handoff
  invariant 3). The Mac database becomes a development copy: still runs, no
  longer canon.
- `cp.padi.io` continues read-only in parallel, untouched.
- Anto repoints his authoring tools (Claude Desktop MCP: `CP_REGISTRY_URL`)
  at `https://cp.cnscp.io` with the production token — his step, not infra's.
- Nightly backups (`40-backup.yaml`) are live from day one; the restore
  drill is this same document from step 2.
