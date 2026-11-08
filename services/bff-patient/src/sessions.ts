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

/** Spec 10.1: patients 30 minutes idle, 12 hours absolute. */
export const PATIENT_IDLE_MS = 30 * 60 * 1000;
export const PATIENT_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

export interface SessionResolver {
  resolve(token: string): Promise<Session | null>;
  revoke(token: string): Promise<void>;
}

/**
 * Dev and test sessions for synthetic subjects. Real passkey / email-OTP sessions arrive in M1
 * (Keycloak). Refuses to construct in staging or production.
 */
export class DevSessionStore implements SessionResolver {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;

  constructor(env: EnvironmentName, now: () => number = Date.now) {
    if (isDeployedEnvironment(env)) {
      throw new Error(`DevSessionStore is not allowed in ${env}.`);
    }
    this.#now = now;
  }

  /** Returns an opaque 256-bit token for the cookie. */
  create(claims: ServiceClaims): string {
    const token = randomBytes(32).toString('base64url');
    const t = this.#now();
    this.#sessions.set(token, { claims, createdAt: t, lastSeenAt: t });
    return token;
  }

  resolve(token: string): Promise<Session | null> {
    const s = this.#sessions.get(token);
    if (!s) return Promise.resolve(null);
    const t = this.#now();
    if (t - s.lastSeenAt > PATIENT_IDLE_MS || t - s.createdAt > PATIENT_ABSOLUTE_MS) {
      this.#sessions.delete(token);
      return Promise.resolve(null);
    }
    s.lastSeenAt = t;
    return Promise.resolve(s);
  }

  revoke(token: string): Promise<void> {
    this.#sessions.delete(token);
    return Promise.resolve();
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
