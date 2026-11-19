import { randomBytes } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

/** A record-system client as the API resolves it (spec 16.3). */
export interface Client {
  readonly id: string;
  readonly orgId: string;
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
  readonly scopes: readonly string[];
  readonly active: boolean;
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Verifies a SMART Backend Services client assertion (private_key_jwt): signed with one of the
 * client's registered public keys (ES384 or RS384, chosen by `kid`), iss = sub = client_id,
 * aud = our token endpoint, expiring within 5 minutes, and a jti never used before.
 */
export async function verifyClientAssertion(
  assertion: string,
  clientId: string,
  client: Client,
  tokenUrl: string,
  /** Reserves (client, jti) until it expires; false if used before (shared, durable). */
  reserve: (clientId: string, jti: string, expiresAt: Date) => Promise<boolean>,
  nowMs: number,
): Promise<void> {
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(assertion).kid;
  } catch {
    throw new AuthError('invalid_client');
  }
  const jwk = client.jwks.keys.find((k) => k['kid'] === kid);
  if (!jwk) throw new AuthError('invalid_client');
  const alg = jwk['alg'];
  if (alg !== 'ES384' && alg !== 'RS384') throw new AuthError('invalid_client');
  let payload;
  try {
    const key = await importJWK(jwk as JWK, alg);
    ({ payload } = await jwtVerify(assertion, key, {
      algorithms: [alg],
      issuer: clientId,
      subject: clientId,
      audience: tokenUrl,
      currentDate: new Date(nowMs),
      requiredClaims: ['exp', 'jti'],
    }));
  } catch {
    throw new AuthError('invalid_client');
  }
  const exp = (payload.exp ?? 0) * 1000;
  if (exp - nowMs > 5 * 60_000) throw new AuthError('invalid_client');
  if (typeof payload.jti !== 'string' || !(await reserve(clientId, payload.jti, new Date(exp))))
    throw new AuthError('invalid_client');
}

/** The scopes granted: those asked for that the client is registered for (spec 16.3). */
export function grantScopes(requested: string, allowed: readonly string[]): string[] {
  const asked = requested.split(/\s+/).filter(Boolean);
  const granted = asked.filter((s) => allowed.includes(s));
  if (asked.length === 0 || granted.length === 0) throw new AuthError('invalid_scope');
  return granted;
}

export interface AccessToken {
  readonly clientId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

/**
 * Opaque, short-lived access tokens (5 minutes), kept in memory: one instance for now; a shared
 * store comes with the deployment (Section 24 item 41).
 */
export class AccessTokens {
  readonly #tokens = new Map<string, AccessToken>();
  readonly #now: () => number;
  constructor(now: () => number) {
    this.#now = now;
  }
  #prunedAt = Number.NEGATIVE_INFINITY;
  issue(t: Omit<AccessToken, 'expiresAt'>): { token: string; expiresIn: number } {
    const now = this.#now();
    if (now - this.#prunedAt >= 1000) {
      for (const [k, v] of this.#tokens) if (v.expiresAt <= now) this.#tokens.delete(k);
      this.#prunedAt = now;
    }
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, { ...t, expiresAt: now + 300_000 });
    return { token, expiresIn: 300 };
  }
  find(token: string): AccessToken | null {
    const t = this.#tokens.get(token);
    if (!t) return null;
    if (t.expiresAt <= this.#now()) {
      this.#tokens.delete(token);
      return null;
    }
    return t;
  }
}
