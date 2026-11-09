import { randomBytes } from 'node:crypto';
import { isDeployedEnvironment, type EnvironmentName } from '@endo/config';
import type { Membership } from './resolve.ts';

/** `__Host-` prefix: Secure, path=/, no Domain (spec 8.4). SameSite=Strict (ADR-0019 section 5). */
export const SESSION_COOKIE = '__Host-endo_clinic_session';
/** The browser-binding cookie for sign-in attempts: Lax, because the callback is cross-site. */
export const OIDC_COOKIE = '__Host-endo_clinic_oidc';
/** Requests the portal makes on its own (polling) send this header; they never extend idle time. */
export const BACKGROUND_HEADER = 'x-endo-background';

/** Spec 10.2: 15 minutes idle. 12 hours absolute (ADR-0015 realm setting). */
export const CLINIC_IDLE_MS = 15 * 60 * 1000;
export const CLINIC_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

export interface ClinicSession {
  readonly personId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly sid: string | null;
  /** Kept server-side only, as `id_token_hint` for Keycloak logout (ADR-0019 section 6). */
  readonly idToken: string;
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
  readonly idToken: string;
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
   * After a valid callback: a FRESH session id and CSRF token (never the transaction id), always
   * `pending-org`. Activation, even automatic, goes through `activate` (ADR-0019 section 5).
   */
  create(s: NewSession): Promise<string> {
    const token = random();
    const t = this.#now();
    this.#sessions.set(token, {
      personId: s.personId,
      issuer: s.issuer,
      subject: s.subject,
      sid: s.sid,
      idToken: s.idToken,
      state: 'pending-org',
      candidates: [...s.memberships],
      active: null,
      csrfToken: random(),
      createdAt: t,
      lastSeenAt: t,
    });
    return Promise.resolve(token);
  }

  /**
   * Activates one organisation with a membership the caller has just RE-READ, and rotates the
   * session id and CSRF token: the old id stops working at once (ADR-0019 section 5). The absolute
   * deadline is kept. Returns the new token, or null if the old session is gone.
   */
  activate(
    token: string,
    membership: Membership,
    opts: { touch: boolean } = { touch: true },
  ): Promise<string | null> {
    const s = this.#sessions.get(token);
    if (!s) return Promise.resolve(null);
    // Expiry is checked again here, atomically with rotation: a slow membership lookup must not
    // carry an expired session over its deadline (ADR-0019 section 5).
    const t = this.#now();
    this.#sessions.delete(token);
    if (t - s.lastSeenAt > CLINIC_IDLE_MS || t - s.createdAt > CLINIC_ABSOLUTE_MS) {
      return Promise.resolve(null);
    }
    const next = random();
    this.#sessions.set(next, {
      ...s,
      state: 'active',
      active: membership,
      csrfToken: random(),
      // A background request never extends the idle time, not even by rotating.
      lastSeenAt: opts.touch ? t : s.lastSeenAt,
    });
    return Promise.resolve(next);
  }

  /**
   * Async like the durable store will be. `touch: false` checks expiry without counting the
   * request as activity, so background polling cannot keep a session alive (ADR-0019 section 5).
   */
  resolve(
    token: string,
    opts: { touch: boolean } = { touch: true },
  ): Promise<ClinicSession | null> {
    const s = this.#sessions.get(token);
    if (!s) return Promise.resolve(null);
    const t = this.#now();
    if (t - s.lastSeenAt > CLINIC_IDLE_MS || t - s.createdAt > CLINIC_ABSOLUTE_MS) {
      this.#sessions.delete(token);
      return Promise.resolve(null);
    }
    if (opts.touch) s.lastSeenAt = t;
    return Promise.resolve(s);
  }

  revoke(token: string): Promise<void> {
    this.#sessions.delete(token);
    return Promise.resolve();
  }

  /**
   * Back-channel logout (ADR-0019 section 6): revokes every session of this issuer with the given
   * Keycloak session id, or, when no sid is given, every session of the subject. Idempotent.
   */
  revokeMatching(issuer: string, match: { sid?: string; sub?: string }): Promise<number> {
    let revoked = 0;
    for (const [token, s] of this.#sessions) {
      const hit =
        s.issuer === issuer &&
        (match.sid !== undefined
          ? s.sid === match.sid
          : match.sub !== undefined && s.subject === match.sub);
      if (hit) {
        this.#sessions.delete(token);
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
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
