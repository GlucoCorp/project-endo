import { SignJWT, decodeJwt, importJWK, jwtVerify, type JWK } from 'jose';
import { z } from 'zod';
import { uuidv7 } from '@endo/domain';
import { SERVICE_TOKEN_TTL_SECONDS, ServiceTokenError, type ServiceName } from './service-token.ts';

/**
 * Workload tokens: service-to-service calls made on nobody's behalf, such as the API creating a
 * person during enrolment or the erasure job shredding one (ADR-0018). They name the calling
 * service and the scopes it requests; there is no end-user subject. A different `typ` from service
 * tokens, so neither can be used as the other. Mutual TLS is the transport layer on top (infra).
 */
type JoseKey = Awaited<ReturnType<typeof importJWK>>;

const ALG = 'EdDSA';
const TYP = 'endo-workload+jwt';
const CLOCK_TOLERANCE_SECONDS = 5;
const SEGMENT = /^[a-z][a-z0-9_]{0,31}$/;
/** `area.resource.action`: at least two dot-separated lowercase segments, no backtracking regex. */
const isScope = (s: string): boolean => {
  const parts = s.split('.');
  return s.length <= 64 && parts.length >= 2 && parts.every((p) => SEGMENT.test(p));
};

const WorkloadClaims = z.object({
  scope: z.array(z.string().refine(isScope)).min(1).max(16),
});

export interface WorkloadCaller {
  readonly service: ServiceName;
  readonly scopes: readonly string[];
}

export class WorkloadTokenSigner {
  readonly #key: Promise<JoseKey>;
  readonly #issuer: ServiceName;
  readonly #clock: () => Date;

  constructor(privateJwk: JWK, issuer: ServiceName, clock: () => Date = () => new Date()) {
    this.#key = importJWK(privateJwk, ALG);
    this.#issuer = issuer;
    this.#clock = clock;
  }

  /** Requests only the scopes this call needs (least privilege per call). */
  async sign(scopes: readonly string[], audience: ServiceName): Promise<string> {
    const { scope } = WorkloadClaims.parse({ scope: [...scopes] });
    const nowSec = Math.floor(this.#clock().getTime() / 1000);
    return new SignJWT({ scope })
      .setProtectedHeader({ alg: ALG, typ: TYP })
      .setIssuer(this.#issuer)
      .setSubject(this.#issuer)
      .setAudience(audience)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + SERVICE_TOKEN_TTL_SECONDS)
      .setJti(uuidv7())
      .sign(await this.#key);
  }
}

/** A trusted calling service: its own public key and the scopes it may ever request. */
export interface TrustedWorkload {
  readonly publicJwk: JWK;
  readonly scopes: readonly string[];
}

export class WorkloadTokenVerifier {
  readonly #audience: ServiceName;
  readonly #callers: ReadonlyMap<string, { key: Promise<JoseKey>; scopes: readonly string[] }>;
  readonly #clock: () => Date;

  constructor(
    audience: ServiceName,
    trusted: Partial<Record<ServiceName, TrustedWorkload>>,
    clock: () => Date = () => new Date(),
  ) {
    this.#audience = audience;
    this.#callers = new Map(
      Object.entries(trusted).map(([name, t]) => [
        name,
        { key: importJWK(t.publicJwk, ALG), scopes: [...t.scopes] },
      ]),
    );
    this.#clock = clock;
  }

  /**
   * Verifies an `Authorization` header and that the caller may hold every requested scope.
   * Throws `ServiceTokenError`; never returns partial results.
   */
  async verifyHeader(header: string | undefined): Promise<WorkloadCaller> {
    if (!header) throw new ServiceTokenError('authn.missing');
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    const token = match?.[1];
    if (!token) throw new ServiceTokenError('authn.invalid');
    try {
      // The unverified issuer only selects the key; the signature check then binds it.
      const claimed = decodeJwt(token).iss;
      const caller = typeof claimed === 'string' ? this.#callers.get(claimed) : undefined;
      if (!caller || typeof claimed !== 'string') throw new ServiceTokenError('authn.invalid');
      const { payload } = await jwtVerify(token, await caller.key, {
        algorithms: [ALG],
        audience: this.#audience,
        issuer: claimed,
        subject: claimed,
        typ: TYP,
        maxTokenAge: SERVICE_TOKEN_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
        currentDate: this.#clock(),
      });
      const { scope } = WorkloadClaims.parse(payload);
      if (!scope.every((s) => caller.scopes.includes(s))) {
        throw new ServiceTokenError('authn.invalid');
      }
      return { service: claimed as ServiceName, scopes: scope };
    } catch {
      throw new ServiceTokenError('authn.invalid');
    }
  }
}
