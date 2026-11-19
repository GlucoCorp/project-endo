import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * OIDC for clinician sign-in (ADR-0019 sections 1-3) and the patient's enrolment handoff
 * (ADR-0021 section 5). Authorisation code with PKCE S256,
 * `response_mode=query`, exact redirect URI. Everything here is configuration-driven: issuer and
 * endpoints come from trusted config, never from a token or discovery at request time.
 */
export interface OidcConfig {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Exact `acr` a fresh clinician sign-in must carry (ADR-0019 section 3). */
  readonly requiredAcr: string;
  /** RP-initiated logout (ADR-0019 section 6). */
  readonly endSessionEndpoint: string;
  readonly postLogoutRedirectUri: string;
}

/**
 * One sign-in attempt. `binding` is the browser's binding value (held only in its cookie), so a
 * callback from another browser can never complete it; several tabs of one browser share the
 * binding but each attempt has its own `state`.
 */
export interface OidcTransaction {
  readonly binding: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly createdAt: number;
}

export const TRANSACTION_TTL_MS = 10 * 60 * 1000;
/** Upper bound on pending attempts (dev store); beyond it new logins are refused. */
export const MAX_PENDING_TRANSACTIONS = 10_000;
const MAX_TOKEN_AGE_S = 5 * 60;
const CLOCK_SKEW_S = 30;

const random = () => randomBytes(32).toString('base64url');
export const newBinding = random;

export class OidcError extends Error {
  /** Safe, generic code; never the reason details (which could help an attacker). */
  readonly code = 'authn.oidc_failed';
  constructor() {
    super('authn.oidc_failed');
    this.name = 'OidcError';
  }
}

/**
 * In-memory transactions for dev and tests; refused in staging and production (ADR-0019 section
 * 5: the durable store needs atomic compare-and-set across replicas). Keyed by `state`.
 */
export class TransactionStore {
  readonly #tx = new Map<string, OidcTransaction>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Drops expired attempts, oldest first. The map keeps insertion order, so it stops at the first
   * live one: each attempt is visited once over its life, never once per new attempt (a flood
   * of sign-ins must not cost quadratic time). If the clock ever steps back, an expired attempt
   * may stay a little longer, but `consume` checks its age again.
   */
  #prune(): void {
    const t = this.#now();
    for (const [state, tx] of this.#tx) {
      if (t - tx.createdAt <= TRANSACTION_TTL_MS) break;
      this.#tx.delete(state);
    }
  }

  create(binding: string): OidcTransaction {
    this.#prune();
    if (this.#tx.size >= MAX_PENDING_TRANSACTIONS) throw new OidcError();
    const tx: OidcTransaction = {
      binding,
      state: random(),
      nonce: random(),
      verifier: random(),
      createdAt: this.#now(),
    };
    this.#tx.set(tx.state, tx);
    return tx;
  }

  /**
   * Consumes the attempt named by `state` atomically, once. It must belong to this browser's
   * binding and be unexpired; a binding mismatch leaves it for its real owner.
   */
  consume(binding: string | null, state: string | null): OidcTransaction {
    if (!binding || !state) throw new OidcError();
    const tx = this.#tx.get(state);
    if (!tx || tx.binding !== binding) throw new OidcError();
    this.#tx.delete(state);
    if (this.#now() - tx.createdAt > TRANSACTION_TTL_MS) throw new OidcError();
    return tx;
  }

  get size(): number {
    return this.#tx.size;
  }
}

/** The PKCE S256 challenge of a transaction (the verifier never leaves the BFF). */
export function codeChallenge(tx: OidcTransaction): string {
  return createHash('sha256').update(tx.verifier).digest('base64url');
}

/**
 * The authorisation request URL. `extra` adds parameters (the enrolment handoff reference, ADR-0021
 * section 5); it can never override the standard ones.
 */
export function authorizationUrl(
  config: OidcConfig,
  tx: OidcTransaction,
  extra: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    ...extra,
    response_type: 'code',
    response_mode: 'query',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid',
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: codeChallenge(tx),
    code_challenge_method: 'S256',
    // Always a fresh authentication (ADR-0019 section 3); never a silent SSO reuse.
    prompt: 'login',
    max_age: '0',
  }).toString();
  return url.toString();
}

/** Exchanges the code at the token endpoint with client authentication and the PKCE verifier. */
export async function exchangeCode(
  config: OidcConfig,
  code: string,
  tx: OidcTransaction,
  fetchImpl: typeof fetch,
): Promise<{ idToken: string; refreshToken: string }> {
  const res = await tokenRequest(config, fetchImpl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: tx.verifier,
  });
  if (!res.ok) throw new OidcError();
  const body = (await res.json()) as { id_token?: unknown; refresh_token?: unknown };
  if (typeof body.id_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new OidcError();
  }
  return { idToken: body.id_token, refreshToken: body.refresh_token };
}

/** Keycloak said the refresh token is no longer valid: the Keycloak session has ended. */
export class RefreshRejectedError extends Error {
  constructor() {
    super('authn.keycloak_session_ended');
    this.name = 'RefreshRejectedError';
  }
}

/**
 * Revalidates the Keycloak session (ADR-0019 section 6): a refresh-token grant. Keycloak rotates
 * refresh tokens and refuses reuse, so the caller must store the returned one. A 400/401 answer
 * means the Keycloak session ended (RefreshRejectedError); anything else is an outage (OidcError).
 */
export async function refreshSession(
  config: OidcConfig,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<{ refreshToken: string }> {
  let res: Response;
  try {
    res = await tokenRequest(config, fetchImpl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch {
    throw new OidcError();
  }
  if (res.status === 400 || res.status === 401) throw new RefreshRejectedError();
  if (!res.ok) throw new OidcError();
  const body = (await res.json()) as { refresh_token?: unknown };
  if (typeof body.refresh_token !== 'string') throw new OidcError();
  return { refreshToken: body.refresh_token };
}

/**
 * Ends the Keycloak session behind a refresh token, from the server (Keycloak's logout endpoint
 * called with the refresh token and client authentication). Used where sending the browser to
 * Keycloak would leave a page behind on a shared phone (patient sign-out, RISK-S02). True when
 * Keycloak confirmed; false otherwise. Never throws: the caller has already ended its own session.
 */
export async function endKeycloakSession(
  config: OidcConfig,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(config.endSessionEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuth(config),
      },
      body: new URLSearchParams({ refresh_token: refreshToken }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  }
}

const basicAuth = (config: OidcConfig) =>
  `Basic ${Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
  ).toString('base64')}`;

/** A token-endpoint call with client authentication (client_secret_basic). */
function tokenRequest(
  config: OidcConfig,
  fetchImpl: typeof fetch,
  params: Record<string, string>,
): Promise<Response> {
  return fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(config),
    },
    body: new URLSearchParams(params).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
}

export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  /** Keycloak session id, for back-channel logout (ADR-0019 section 6). */
  readonly sid: string | null;
}

/**
 * Validates the ID token (ADR-0019 section 2): signature by the configured JWKS (RS256/ES256
 * only), exact issuer, audience with `azp`, `exp`, `iat` and `auth_time` within 5 minutes, `nbf`,
 * non-empty `sub`, the transaction nonce, and the exact clinician `acr`.
 */
export async function validateIdToken(
  config: OidcConfig,
  idToken: string,
  tx: OidcTransaction,
  keys: JWTVerifyGetKey,
  now: () => Date,
): Promise<VerifiedIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: CLOCK_SKEW_S,
      maxTokenAge: MAX_TOKEN_AGE_S,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'auth_time'],
      currentDate: now(),
    });
    const nowS = Math.floor(now().getTime() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const ok =
      typeof payload.sub === 'string' &&
      payload.sub.length > 0 &&
      payload['nonce'] === tx.nonce &&
      typeof payload['auth_time'] === 'number' &&
      nowS - payload['auth_time'] <= MAX_TOKEN_AGE_S + CLOCK_SKEW_S &&
      payload['auth_time'] - nowS <= CLOCK_SKEW_S &&
      payload['acr'] === config.requiredAcr &&
      // azp, when present, must be us; with several audiences it is required (OIDC Core 3.1.3.7).
      (payload['azp'] === undefined ? audiences.length === 1 : payload['azp'] === config.clientId);
    if (!ok) throw new OidcError();
    const sid = payload['sid'];
    return {
      issuer: config.issuer,
      subject: payload.sub as string,
      sid: typeof sid === 'string' ? sid : null,
    };
  } catch {
    throw new OidcError();
  }
}

/** Keycloak RP-initiated logout URL, with the session's ID token as a hint (ADR-0019 section 6). */
export function logoutUrl(config: OidcConfig, idToken: string): string {
  const url = new URL(config.endSessionEndpoint);
  url.search = new URLSearchParams({
    id_token_hint: idToken,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    client_id: config.clientId,
  }).toString();
  return url.toString();
}

const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * Remembers logout-token ids so a captured token cannot be replayed (dev store; the durable store
 * comes with the session store). Entries expire with the token-age window.
 */
export class SeenTokenIds {
  readonly #seen = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** True the first time an id is seen within the window; false for a replay. */
  firstUse(jti: string): boolean {
    const t = this.#now();
    for (const [id, at] of this.#seen)
      if (t - at > 2 * MAX_TOKEN_AGE_S * 1000) this.#seen.delete(id);
    if (this.#seen.has(jti)) return false;
    this.#seen.set(jti, t);
    return true;
  }
}

/**
 * Validates a back-channel logout token (OpenID Connect Back-Channel Logout 1.0, section 2.6):
 * signature by the configured JWKS, exact issuer, our audience, `iat` within the window, a `jti`
 * not seen before, the back-channel logout event, NO `nonce`, and a `sid` or `sub`.
 */
export async function validateLogoutToken(
  config: OidcConfig,
  token: string,
  keys: JWTVerifyGetKey,
  seen: SeenTokenIds,
  now: () => Date,
): Promise<{ sid?: string; sub?: string }> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: CLOCK_SKEW_S,
      maxTokenAge: MAX_TOKEN_AGE_S,
      requiredClaims: ['iss', 'aud', 'iat', 'exp', 'jti', 'events'],
      currentDate: now(),
    });
    const events = payload['events'];
    const sid = typeof payload['sid'] === 'string' ? payload['sid'] : undefined;
    const sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;
    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    const ok =
      isObject(events) &&
      Object.prototype.hasOwnProperty.call(events, BACKCHANNEL_EVENT) &&
      isObject(new Map(Object.entries(events)).get(BACKCHANNEL_EVENT)) &&
      payload['nonce'] === undefined &&
      (sid !== undefined || sub !== undefined) &&
      typeof payload.jti === 'string' &&
      seen.firstUse(payload.jti);
    if (!ok) throw new OidcError();
    return { ...(sid !== undefined ? { sid } : {}), ...(sub !== undefined ? { sub } : {}) };
  } catch {
    throw new OidcError();
  }
}
