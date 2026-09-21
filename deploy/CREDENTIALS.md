# Credentials: accounts, membership, tokens

Design §15.2 and §15.3. A credential is a bearer token that acts as one `app_user` with a
fixed list of scopes. The Registry stores only the token's SHA-256; the token itself exists
in plaintext exactly once — on the screen of the person who minted it — and nowhere else.

Since 12 September 2026 people mint their own. The operator's part is one act per author:
attaching them to the organization that holds their Prefix.

## The normal path: a person onboards themselves

1. **They sign in** at https://cp.cnscp.io/account with Google or GitHub. That creates their
   account, or links the identity to an account that already carries the same verified
   email (an operator-created row, or their other provider). The Registry keeps no password.
2. **You attach them to the organization** that holds the Prefix they will author under.
   This is the act that decides where their tokens may act; nothing on a token does.

   ```sh
   kubectl -n cp-registry exec deploy/registry -- \
     npm run operator -- user find --email jane@cimetrics.com          # what the Registry knows
   kubectl -n cp-registry exec deploy/registry -- \
     npm run operator -- member add --org "Cimetrics Inc." --user jane@cimetrics.com --role author --by anto@padi.io
   ```

   `member add` works before they have signed in, too: a row created with `user add` is
   claimed by its owner on first sign-in by verified email (§15.3 rule 2).

   If the organization does not hold its Prefix yet — a grandfathered claimant Prefix still in the
   operator's custody, say — release it first (§8.4, operator form), creating the organization in
   the same act:

   ```sh
   kubectl -n cp-registry exec deploy/registry -- \
     npm run operator -- allocation transfer --tlp ibb --to "C4SB (Coalition for Smarter Buildings)" --create \
       --evidence "Released to its claimant under §10.2 ruling 4; <who represents them, and how you know>" --by anto@padi.io
   ```

   Without `--create` an unknown name refuses, so a misspelling cannot make a second organization.
3. **They mint their tokens** on `/account`: a label, a kind, and any subset of the author
   scopes. The token is shown once. Their first act should be a rehearsal
   (`check_publishable` / `?dry_run=true`) so the token's reach is proven before anything
   permanent happens.

No token changes hands. Nothing is sent, shared, vaulted, or read aloud.

## Scopes

| Scope | Allows |
|---|---|
| `register` | claim a name (`PUT /<name>`); rehearse a publication (`POST /<name>/publish?dry_run=true`) |
| `steward` | change Owner / Website on a published version (`PATCH /<name>:n/header`) |
| `release` | release a never-published name (`DELETE /<name>`) |
| `publish` | publish a version — **irreversible** |
| `deprecate` | deprecate a version — one-way |
| `operator` | the §9.2 operator plane: allocate a Prefix. **Never mintable on `/account`.** |

A person who authors takes `register,steward,release,publish,deprecate`. An assistant, a CI
job or any other non-person is minted as `agent` or `service`, gets `register,steward,release`,
and names the person it acts for as principal — on `/account` that is always the person
minting it. It can prepare and rehearse everything and publish nothing.

**Where a token may act is not on the token.** Membership decides: the user the token acts as
must belong to the organization holding the Prefix (or to one the holder granted a scope).
A Cimetrics author's token works under `cimetrics.*` and is refused under `padi.*` with
`no-membership`, whatever its scopes say. A token minted before any membership exists is
refused everywhere until the membership is added — then it works, unchanged.

## The operator path, still there for two cases

Bootstrap (a fresh deployment with nobody signed in yet), and machine credentials whose
person is not going to sign in for them. Everything runs inside the cluster, against the
production database, and records the operator who ran it (`--by`). Nothing here needs a token.

```sh
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- user add --email jane@cimetrics.com --name "Jane Doe" --by anto@padi.io
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- credential mint --user jane@cimetrics.com --kind human \
    --scopes register,steward,release,publish --label "Jane Doe, Cimetrics author" --by anto@padi.io
```

A token minted this way exists in plaintext on the operator's terminal and must reach its
owner out of band, once — a password-manager share or a one-time secret link; never chat,
never email, never a ticket. That handover is the reason the normal path exists; use this
one only when it cannot apply.

## Listing and revoking

People revoke their own tokens on `/account`. The operator can list and revoke any:

```sh
kubectl -n cp-registry exec deploy/registry -- npm run operator -- credential list
kubectl -n cp-registry exec deploy/registry -- \
  npm run operator -- credential revoke --id <uuid> --reason "rotated" --by anto@padi.io
```

Revocation is immediate: the next request with that token answers `401`. Minting and
revoking are audit events (`credential.mint`, `credential.revoke`) under the principal who
did them — the person on `/account`, the operator from the CLI; the public journal shows
them as redacted links. Sign-ins are application log, not registry acts.

## Sign-in configuration

Six variables, all or none (`identityConfigFromEnv`): `CP_OAUTH_GOOGLE_CLIENT_ID`,
`CP_OAUTH_GOOGLE_CLIENT_SECRET`, `CP_OAUTH_GITHUB_CLIENT_ID`, `CP_OAUTH_GITHUB_CLIENT_SECRET`,
`CP_SESSION_SECRET` (`openssl rand -hex 32`), `CP_PUBLIC_ORIGIN` (`https://cp.cnscp.io`; on a
Mac `http://localhost:8082`). On the cluster the first five live in the `registry-oauth`
secret and the Deployment sets the sixth. The Google client lives in the `cnscp-registry`
GCP project (External, in production, basic scopes only); the GitHub OAuth App under the
`CNSCP` organization; both register `<origin>/auth/<provider>/callback`. A host without the
variables runs without sign-in, exactly as before.

Rotating a client secret: add the new one at the provider, update the secret
(`kubectl -n cp-registry create secret generic registry-oauth --from-env-file=… --dry-run=client -o yaml | kubectl apply -f -`),
roll the Deployment, then delete the old one at the provider. Rotating `CP_SESSION_SECRET`
signs everyone out and nothing else.

## The environment credential (retired)

`CP_AUTHOR_TOKEN` / `CP_AUTHOR_USER_ID` (the `registry-auth` secret) was the Phase 0 bootstrap
form. It was removed from the Deployment on 12 September 2026, once the first tokens had been
minted on `/account`; the host logs "authoring: credential table only". The code still honours
the variables if a fresh deployment ever needs to mint its first row before anyone can sign in —
but with sign-in configured that is never necessary: sign in, have the operator `member add`
you, mint. Prefix allocation from the CLI needs no token at all.

## Local development

The same commands work on a Mac against `DATABASE_URL` in `.env`, and `/account` works at
`http://localhost:8082/account` with the six variables in `.env` (the localhost callbacks are
registered at both providers). Point Claude Desktop's MCP config at whichever token and host
you mean it to act on — the production token acts on canon.

## The workspace credential (design §20.3) — on an instance, never on canon

An instance that holds its organization's unpublished forms beside its mirror checks exactly
one credential of its own: `CP_WORKSPACE_TOKEN` (or `CP_WORKSPACE_TOKENS` as `label=token,…`)
with `CP_WORKSPACE_PRINCIPAL`, in the instance's environment, for `PUT` and `DELETE
/<name>:unpublished` only. It has no scopes — there is one act — and its reach is not on the
token: `WORKSPACE_ORGS` fixes what the host will hold, so a leaked token can overwrite one
organization's drafts on that organization's host and nothing else. Two tokens with two
labels tell an author's saves from an assistant's in `updated_by`. The host never holds a
canon token: publishing stays the person's act at `cp.cnscp.io`. See `deploy/INSTANCE.md`.

