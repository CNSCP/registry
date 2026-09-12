# Credentials: minting, handing over, revoking

Design §15.2. A credential is a bearer token that acts as one `app_user` with a fixed
list of scopes. The Registry stores only the token's SHA-256; the token itself exists in
plaintext exactly once — on the terminal of the operator who minted it — and nowhere else.

## Scopes

| Scope | Allows |
|---|---|
| `register` | claim a name (`PUT /<name>`); rehearse a publication (`POST /<name>/publish?dry_run=true`) |
| `steward` | change Owner / Website on a published version (`PATCH /<name>:n/header`) |
| `release` | release a never-published name (`DELETE /<name>`) |
| `publish` | publish a version — **irreversible** |
| `deprecate` | deprecate a version — one-way |
| `operator` | the §9.2 operator plane: allocate a Prefix |

A person who authors gets `register,steward,release,publish,deprecate`. An assistant, a CI
job or any other non-person gets `register,steward,release` and names the person it acts
for (`--principal`): it can prepare and rehearse everything and publish nothing. `operator`
goes on a token used only for operator acts, never on a daily-use one.

**Where a token may act is not on the token.** Membership decides: the user the token acts
as must belong to the organization holding the Prefix (or to one the holder granted a
scope). A Cimetrics author's token works under `cimetrics.*` and is refused under `padi.*`
with `no-membership`, whatever its scopes say.

## Minting

All commands run inside the cluster, against the production database, and record the
operator who ran them (`--by`). Nothing here needs a token.

```sh
# 1. The person, if new to the Registry
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- user add --email jane@cimetrics.com --name "Jane Doe" --by anto@padi.io

# 2. Their membership — this is what decides which Prefixes they may act under
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- member add --org "Cimetrics Inc." --user jane@cimetrics.com --role author --by anto@padi.io

# 3. The token, printed once
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- credential mint --user jane@cimetrics.com --kind human \
    --scopes register,steward,release,publish --label "Jane Doe, Cimetrics author" --by anto@padi.io
```

For an assistant acting for a person:

```sh
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- credential mint --user anto@padi.io --kind agent --principal anto@padi.io \
    --scopes register,steward,release --label "Claude Desktop, for Anto" --by anto@padi.io
```

## Handing a token over

Out of band, and once: a shared vault in a password manager, or a one-time secret link. Never
chat, never email, never a ticket. The recipient's first act should be a rehearsal
(`check_publishable` / `dry_run=true`) so the token's reach is proven before anything
permanent happens.

## Listing and revoking

```sh
kubectl -n cp-registry exec deploy/registry -- npm run operator -- credential list
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- credential revoke --id <uuid> --reason "rotated" --by anto@padi.io
```

Revocation is immediate: the next request with that token answers `401`. Both minting
and revocation are audit events (`credential.mint`, `credential.revoke`); the public journal
shows them as redacted links.

## The environment credential

`CP_AUTHOR_TOKEN` / `CP_AUTHOR_USER_ID` (the `registry-auth` secret) is the Phase 0
bootstrap form and still works beside the table. Once the tokens above exist, remove those
variables from the Deployment and the secret; the host then logs
"authoring: credential table only". Keep one `operator`-scoped token minted before you do,
or allocate the next Prefix from the CLI, which needs no token at all.

## Local development

The same commands work on a Mac against `DATABASE_URL` in `.env`:
`npm run operator -- credential mint …`. Point Claude Desktop's MCP config at whichever
token and host you mean it to act on — the production token acts on canon.
