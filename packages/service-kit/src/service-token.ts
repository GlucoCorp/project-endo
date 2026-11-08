import {
  SignJWT,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose';
import { z } from 'zod';
import { ROLES, uuidv7, type Role } from '@endo/domain';

/**
 * Short-lived, audience-restricted service tokens for BFF -> API calls (spec 8.4; ADR-0006).
 * Ed25519 signatures via `jose`. These carry the authenticated end-user subject; the API trusts
 * them only from allowlisted issuers. Mutual TLS is the transport layer on top (infra slice).
 *
 * RISK-S01, RISK-E01
 */

export type ServiceName =
  'bff-patient' | 'bff-clinic' | 'jobs' | 'integration' | 'api' | 'identity' | 'keycloak';

/** Key type as jose returns it; avoids depending on the global WebCrypto `CryptoKey` type. */
type JoseKey = Awaited<ReturnType<typeof importJWK>>;

const ALG = 'EdDSA';
export const SERVICE_TOKEN_TTL_SECONDS = 60;
const CLOCK_TOLERANCE_SECONDS = 5;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const ClaimsSchema = z.object({
  sub: uuid,
  role: z.enum(ROLES),
  org_id: uuid.nullable(),
  patient_id: uuid.nullable(),
});
export type ServiceClaims = z.infer<typeof ClaimsSchema>;

export class ServiceTokenError extends Error {
  /** Machine code, safe to log and audit. */
  readonly code: 'authn.missing' | 'authn.invalid';

  constructor(code: 'authn.missing' | 'authn.invalid') {
    super(code);
    this.name = 'ServiceTokenError';
    this.code = code;
  }
}

/** Dev and test only: in deployed environments key pairs come from the secrets manager. */
export async function generateServiceKeyPair(): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) };
}

export class ServiceTokenSigner {
  readonly #key: Promise<JoseKey>;
  readonly #issuer: ServiceName;
  readonly #clock: () => Date;

  constructor(privateJwk: JWK, issuer: ServiceName, clock: () => Date = () => new Date()) {
    this.#key = importJWK(privateJwk, ALG);
    this.#issuer = issuer;
    this.#clock = clock;
  }

  async sign(claims: ServiceClaims, audience: ServiceName): Promise<string> {
    const valid = ClaimsSchema.parse(claims);
    const nowSec = Math.floor(this.#clock().getTime() / 1000);
    return new SignJWT({ role: valid.role, org_id: valid.org_id, patient_id: valid.patient_id })
      .setProtectedHeader({ alg: ALG, typ: 'endo-service+jwt' })
      .setIssuer(this.#issuer)
      .setAudience(audience)
      .setSubject(valid.sub)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + SERVICE_TOKEN_TTL_SECONDS)
      .setJti(uuidv7())
      .sign(await this.#key);
  }
}

/**
 * A caller the API trusts: its own public key, and the end-user roles it may vouch for. The patient
 * BFF may only assert `patient`; a compromised patient BFF therefore cannot mint clinician tokens,
 * and no caller can verify with another caller's key (RISK-S03, RISK-E01).
 */
export interface TrustedIssuer {
  readonly publicJwk: JWK;
  readonly roles: readonly Role[];
}

export class ServiceTokenVerifier {
  readonly #audience: ServiceName;
  readonly #issuers: ReadonlyMap<string, { key: Promise<JoseKey>; roles: readonly Role[] }>;
  readonly #clock: () => Date;

  constructor(
    audience: ServiceName,
    trusted: Partial<Record<ServiceName, TrustedIssuer>>,
    clock: () => Date = () => new Date(),
  ) {
    this.#audience = audience;
    this.#issuers = new Map(
      Object.entries(trusted).map(([name, t]) => [
        name,
        { key: importJWK(t.publicJwk, ALG), roles: [...t.roles] },
      ]),
    );
    this.#clock = clock;
  }

  /** Verifies an `Authorization` header value. Throws `ServiceTokenError`; never returns partial claims. */
  async verifyHeader(header: string | undefined): Promise<ServiceClaims & { iss: ServiceName }> {
    if (!header) throw new ServiceTokenError('authn.missing');
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    const token = match?.[1];
    if (!token) throw new ServiceTokenError('authn.invalid');
    try {
      // The unverified issuer only selects which key to try; the signature check then binds it.
      const claimedIssuer = decodeJwt(token).iss;
      const trusted = claimedIssuer === undefined ? undefined : this.#issuers.get(claimedIssuer);
      if (!trusted || claimedIssuer === undefined) throw new ServiceTokenError('authn.invalid');
      const { payload } = await jwtVerify(token, await trusted.key, {
        algorithms: [ALG],
        audience: this.#audience,
        issuer: claimedIssuer,
        typ: 'endo-service+jwt',
        maxTokenAge: SERVICE_TOKEN_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
        currentDate: this.#clock(),
      });
      const claims = ClaimsSchema.parse(payload);
      if (!trusted.roles.includes(claims.role)) throw new ServiceTokenError('authn.invalid');
      return { ...claims, iss: claimedIssuer as ServiceName };
    } catch {
      throw new ServiceTokenError('authn.invalid');
    }
  }
}
