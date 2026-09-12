/**
 * Identity providers — design §15.3.
 *
 * One small interface, two implementations, one fake. A provider's whole job
 * is to turn "the browser came back from the provider with this code" into an
 * AssertedIdentity — subject, email, whether the provider vouches for the
 * email, a display name — and nothing else. The linking rule (store.ts)
 * decides what that means.
 *
 * Google is OpenID Connect: authorization code with PKCE, then the ID token
 * from the token endpoint, verified against Google's published keys (RS256)
 * and checked for issuer, audience, expiry and nonce. GitHub is plain OAuth
 * 2.0: code exchange, then /user and /user/emails, and the primary email only
 * counts if GitHub marks it verified.
 *
 * Deliberately no library: the two flows are a few hundred lines of
 * well-specified HTTP and Node's crypto does RS256, so the whole path from
 * redirect to identity is readable in this file. `fetch` is injectable so the
 * tests drive both providers without the network.
 */

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import type { AssertedIdentity, ProviderName } from './store.ts';

/** What the browser is sent away with, and what must come back. */
export type AuthorizationStart = {
  url: string;
  /** Opaque, unguessable; must match on return. */
  state: string;
  /** PKCE verifier (Google) — held by us, never sent to the browser in the clear. */
  codeVerifier: string;
  /** OIDC nonce (Google) — bound into the ID token. */
  nonce: string;
};

export interface Provider {
  readonly name: ProviderName;
  start(redirectUri: string): AuthorizationStart;
  finish(code: string, redirectUri: string, started: Pick<AuthorizationStart, 'codeVerifier' | 'nonce'>): Promise<AssertedIdentity>;
}

export type FetchLike = typeof fetch;

export class ProviderError extends Error {
  provider: ProviderName;
  constructor(provider: ProviderName, message: string) {
    super(`${provider}: ${message}`);
    this.provider = provider;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function random(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

// ---------------------------------------------------------------------------
// Google — OpenID Connect
// ---------------------------------------------------------------------------

export const GOOGLE = {
  issuer: 'https://accounts.google.com',
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
} as const;

type GoogleOptions = { clientId: string; clientSecret: string; fetch?: FetchLike; endpoints?: Partial<typeof GOOGLE>; now?: () => number };

export class GoogleProvider implements Provider {
  readonly name = 'google' as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetch: FetchLike;
  private readonly endpoints: typeof GOOGLE;
  private readonly now: () => number;
  private keys: Map<string, JsonWebKey> = new Map();
  private keysFetchedAt = 0;

  constructor(opts: GoogleOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetch = opts.fetch ?? fetch;
    this.endpoints = { ...GOOGLE, ...(opts.endpoints ?? {}) };
    this.now = opts.now ?? (() => Date.now());
  }

  start(redirectUri: string): AuthorizationStart {
    const state = random();
    const codeVerifier = random(48);
    const nonce = random();
    const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
    const url = new URL(this.endpoints.authorization);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    return { url: url.toString(), state, codeVerifier, nonce };
  }

  async finish(code: string, redirectUri: string, started: Pick<AuthorizationStart, 'codeVerifier' | 'nonce'>): Promise<AssertedIdentity> {
    const res = await this.fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: started.codeVerifier,
      }),
    });
    if (!res.ok) throw new ProviderError('google', `token endpoint answered ${res.status}`);
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new ProviderError('google', 'token endpoint returned no id_token');
    const claims = await this.verifyIdToken(body.id_token, started.nonce);
    return {
      provider: 'google',
      subject: claims.sub,
      email: claims.email ?? '',
      emailVerified: claims.email_verified === true && !!claims.email,
      displayName: claims.name ?? null,
    };
  }

  private async verifyIdToken(jwt: string, nonce: string): Promise<{ sub: string; email?: string; email_verified?: boolean; name?: string }> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new ProviderError('google', 'id_token is not a JWT');
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) throw new ProviderError('google', `unexpected id_token header (${header.alg ?? 'no alg'})`);
    const jwk = await this.key(header.kid);
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf8'), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    if (!ok) throw new ProviderError('google', 'id_token signature does not verify');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as {
      iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string; email_verified?: boolean; name?: string;
    };
    if (claims.iss !== GOOGLE.issuer && claims.iss !== 'accounts.google.com') throw new ProviderError('google', `id_token issuer ${claims.iss}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) throw new ProviderError('google', 'id_token audience is not this client');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now()) throw new ProviderError('google', 'id_token has expired');
    if (claims.nonce !== nonce) throw new ProviderError('google', 'id_token nonce does not match');
    if (!claims.sub) throw new ProviderError('google', 'id_token carries no subject');
    return { sub: claims.sub, ...(claims.email ? { email: claims.email } : {}), ...(claims.email_verified !== undefined ? { email_verified: claims.email_verified } : {}), ...(claims.name ? { name: claims.name } : {}) };
  }

  /** Google rotates keys; fetch on a miss, and at most once a minute otherwise. */
  private async key(kid: string): Promise<JsonWebKey> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    if (this.now() - this.keysFetchedAt > 60_000) {
      const res = await this.fetch(this.endpoints.jwks, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new ProviderError('google', `jwks endpoint answered ${res.status}`);
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
      this.keys = new Map((body.keys ?? []).filter((k) => k.kid).map((k) => [k.kid!, k]));
      this.keysFetchedAt = this.now();
    }
    const found = this.keys.get(kid);
    if (!found) throw new ProviderError('google', `no published key with kid ${kid}`);
    return found;
  }
}

// ---------------------------------------------------------------------------
// GitHub — OAuth 2.0
// ---------------------------------------------------------------------------

export const GITHUB = {
  authorization: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
  emails: 'https://api.github.com/user/emails',
} as const;

type GitHubOptions = { clientId: string; clientSecret: string; fetch?: FetchLike; endpoints?: Partial<typeof GITHUB> };

export class GitHubProvider implements Provider {
  readonly name = 'github' as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetch: FetchLike;
  private readonly endpoints: typeof GITHUB;

  constructor(opts: GitHubOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetch = opts.fetch ?? fetch;
    this.endpoints = { ...GITHUB, ...(opts.endpoints ?? {}) };
  }

  start(redirectUri: string): AuthorizationStart {
    const state = random();
    const url = new URL(this.endpoints.authorization);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return { url: url.toString(), state, codeVerifier: '', nonce: '' };
  }

  async finish(code: string, redirectUri: string): Promise<AssertedIdentity> {
    const tokenRes = await this.fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) throw new ProviderError('github', `token endpoint answered ${tokenRes.status}`);
    const token = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!token.access_token) throw new ProviderError('github', `token endpoint returned no access_token (${token.error ?? 'no error given'})`);

    const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'cp-registry' };
    const userRes = await this.fetch(this.endpoints.user, { headers });
    if (!userRes.ok) throw new ProviderError('github', `/user answered ${userRes.status}`);
    const user = (await userRes.json()) as { id?: number | string; login?: string; name?: string | null };
    if (user.id === undefined || user.id === null) throw new ProviderError('github', '/user carries no id');

    const emailsRes = await this.fetch(this.endpoints.emails, { headers });
    if (!emailsRes.ok) throw new ProviderError('github', `/user/emails answered ${emailsRes.status}`);
    const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
    const primary = emails.find((e) => e.primary) ?? emails[0];

    // The access token was for this one exchange; it is not retained.
    return {
      provider: 'github',
      subject: String(user.id),
      email: primary?.email ?? '',
      emailVerified: primary?.verified === true,
      displayName: user.name || user.login || null,
    };
  }
}

// ---------------------------------------------------------------------------
// Fake — for tests
// ---------------------------------------------------------------------------

/** Returns whatever the test says it should. `finish` ignores the code unless told to refuse. */
export class FakeProvider implements Provider {
  readonly name: ProviderName;
  identity: AssertedIdentity;
  refuse: string | null = null;
  constructor(name: ProviderName, identity: AssertedIdentity) {
    this.name = name;
    this.identity = identity;
  }
  start(redirectUri: string): AuthorizationStart {
    const state = random();
    return { url: `https://fake.example/${this.name}?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`, state, codeVerifier: 'v', nonce: 'n' };
  }
  async finish(): Promise<AssertedIdentity> {
    if (this.refuse) throw new ProviderError(this.name, this.refuse);
    return this.identity;
  }
}
