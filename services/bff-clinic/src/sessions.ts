import { randomBytes } from 'node:crypto';
import { isDeployedEnvironment, type EnvironmentName } from '@endo/config';
import type { Membership } from './resolve.ts';

/** `__Host-` prefix: Secure, path=/, no Domain (spec 8.4). SameSite=Strict (ADR-0019 section 5). */
export const SESSION_COOKIE = '__Host-endo_clinic_session';
/** The OIDC transaction cookie: Lax, because the callback is a cross-site top-level GET. */
export const OIDC_COOKIE = '__Host-endo_clinic_oidc';

/** Spec 10.2: 15 minutes idle. 12 hours absolute (ADR-0015 realm setting). */
export const CLINIC_IDLE_MS = 15 * 60 * 1000;
export const CLINIC_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

export interface ClinicSession {
  readonly personId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly sid: string | null;
  /** `pending-org` until one organisation is chosen (ADR-0019 section 5). */
  readonly state: 'pending-org' | 'active';
  readonly candidates: readonly Membership[];
  readonly active: Membership | null;
  readonly csrfToken: string;
  readonly createdAt: number;
  lastSeenAt: number;
}

export interface NewSession {
  readonly personId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly sid: string | null;
  readonly memberships: readonly Membership[];
}

const random = () => randomBytes(32).toString('base64url');

/**
 * Dev and test session store. Refuses staging and production: the durable store with atomic
 * expiry across replicas is part of the infrastructure slice (ADR-0019 section 5).
 */
export class InMemoryClinicSessions {
  readonly #sessions = new Map<string, ClinicSession>();
  readonly #now: () => number;

  constructor(env: EnvironmentName, now: () => number = Date.now) {
    if (isDeployedEnvironment(env)) {
      throw new Error(`InMemoryClinicSessions is not allowed in ${env}.`);
    }
    this.#now = now;
  }

  /**
   * After a valid callback: a FRESH session id and CSRF token (never the transaction id). With
   * exactly one membership the session is active at once; otherwise it waits for a choice.
   */
  create(s: NewSession): Promise<string> {
    const token = random();
    const t = this.#now();
    const only = s.memberships.length === 1 ? (s.memberships[0] ?? null) : null;
    this.#sessions.set(token, {
      personId: s.personId,
      issuer: s.issuer,
      subject: s.subject,
      sid: s.sid,
      state: only ? 'active' : 'pending-org',
      candidates: [...s.memberships],
      active: only,
      csrfToken: random(),
      createdAt: t,
      lastSeenAt: t,
    });
    return Promise.resolve(token);
  }

  /** Async like the durable store will be. */
  resolve(token: string): Promise<ClinicSession | null> {
    const s = this.#sessions.get(token);
    if (!s) return Promise.resolve(null);
    const t = this.#now();
    if (t - s.lastSeenAt > CLINIC_IDLE_MS || t - s.createdAt > CLINIC_ABSOLUTE_MS) {
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

/** Reads one cookie by name. Null if absent, duplicated (cookie tossing) or implausible. */
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
