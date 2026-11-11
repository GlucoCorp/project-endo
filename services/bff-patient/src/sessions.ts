import { randomBytes } from 'node:crypto';
import { isDeployedEnvironment, type EnvironmentName } from '@endo/config';
import type { ServiceClaims } from '@endo/service-kit';

/** `__Host-` prefix: Secure, path=/, no Domain, so subdomains cannot set or read it (spec 8.4). */
export const SESSION_COOKIE = '__Host-endo_session';

export interface Session {
  readonly claims: ServiceClaims;
  readonly createdAt: number;
  lastSeenAt: number;
}

/**
 * After her first passkey and before activation (ADR-0021 section 12). It allows only her consent
 * screens, cancelling and signing out; it never authorises an API call.
 */
export interface ConsentPendingSession {
  readonly transactionId: string;
  /** Keycloak's subject from the validated ID token: the provisional user. */
  readonly subject: string;
  readonly createdAt: number;
  lastSeenAt: number;
}

/** Spec 10.1: patients 30 minutes idle, 12 hours absolute. */
export const PATIENT_IDLE_MS = 30 * 60 * 1000;
export const PATIENT_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** A consent-pending session never outlives the enrolment's own absolute deadline (60 minutes). */
export const CONSENT_PENDING_ABSOLUTE_MS = 60 * 60 * 1000;

export interface SessionResolver {
  /** Patient sessions only: a consent-pending session never resolves here. */
  resolve(token: string): Promise<Session | null>;
  revoke(token: string): Promise<void>;
}

/** What enrolment needs from the session store (ADR-0021 section 12). */
export interface ConsentSessions {
  /** A fresh token for a consent-pending session. */
  createConsentPending(transactionId: string, subject: string): Promise<string>;
  consentPending(token: string): Promise<ConsentPendingSession | null>;
  /**
   * Atomically ends the consent-pending session and creates a patient session with a new token.
   * Null when the old session is gone or is not for this transaction and subject.
   */
  rotate(
    token: string,
    transactionId: string,
    subject: string,
    claims: ServiceClaims,
  ): Promise<string | null>;
  revoke(token: string): Promise<void>;
  /** A fresh token for a patient session (a returning patient's sign-in). */
  createPatient(claims: ServiceClaims): Promise<string>;
}

type Entry =
  | { readonly kind: 'patient'; readonly session: Session }
  | { readonly kind: 'consent-pending'; readonly session: ConsentPendingSession };

const random = () => randomBytes(32).toString('base64url');

/**
 * Dev and test sessions. Refuses to construct in staging or production: the durable store with
 * atomic expiry across replicas belongs to the infrastructure slice (as for the clinic BFF,
 * ADR-0019 section 5).
 */
export class DevSessionStore implements SessionResolver, ConsentSessions {
  readonly #sessions = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(env: EnvironmentName, now: () => number = Date.now) {
    if (isDeployedEnvironment(env)) {
      throw new Error(`DevSessionStore is not allowed in ${env}.`);
    }
    this.#now = now;
  }

  /** Returns an opaque 256-bit token for the cookie. */
  create(claims: ServiceClaims): string {
    const token = random();
    const t = this.#now();
    this.#sessions.set(token, {
      kind: 'patient',
      session: { claims, createdAt: t, lastSeenAt: t },
    });
    return token;
  }

  createPatient(claims: ServiceClaims): Promise<string> {
    return Promise.resolve(this.create(claims));
  }

  createConsentPending(transactionId: string, subject: string): Promise<string> {
    const token = random();
    const t = this.#now();
    this.#sessions.set(token, {
      kind: 'consent-pending',
      session: { transactionId, subject, createdAt: t, lastSeenAt: t },
    });
    return Promise.resolve(token);
  }

  resolve(token: string): Promise<Session | null> {
    const e = this.#live(token);
    return Promise.resolve(e?.kind === 'patient' ? e.session : null);
  }

  consentPending(token: string): Promise<ConsentPendingSession | null> {
    const e = this.#live(token);
    return Promise.resolve(e?.kind === 'consent-pending' ? e.session : null);
  }

  rotate(
    token: string,
    transactionId: string,
    subject: string,
    claims: ServiceClaims,
  ): Promise<string | null> {
    const e = this.#live(token);
    if (
      e?.kind !== 'consent-pending' ||
      e.session.transactionId !== transactionId ||
      e.session.subject !== subject
    )
      return Promise.resolve(null);
    // Synchronous between the check and the swap: no other caller can rotate it twice.
    this.#sessions.delete(token);
    return Promise.resolve(this.create(claims));
  }

  revoke(token: string): Promise<void> {
    this.#sessions.delete(token);
    return Promise.resolve();
  }

  /** The entry if it has not expired; an expired one is removed. Touches it on use. */
  #live(token: string): Entry | undefined {
    const e = this.#sessions.get(token);
    if (!e) return undefined;
    const t = this.#now();
    const absolute = e.kind === 'patient' ? PATIENT_ABSOLUTE_MS : CONSENT_PENDING_ABSOLUTE_MS;
    if (t - e.session.lastSeenAt > PATIENT_IDLE_MS || t - e.session.createdAt > absolute) {
      this.#sessions.delete(token);
      return undefined;
    }
    e.session.lastSeenAt = t;
    return e;
  }
}

/**
 * Reads one cookie by name from a Cookie header. Returns null if absent, duplicated (possible
 * cookie-tossing attempt) or not a plausible token.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const values = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`))
    .map((p) => p.slice(name.length + 1));
  if (values.length !== 1) return null;
  const value = values[0] ?? '';
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}
