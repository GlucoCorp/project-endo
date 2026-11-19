import type { ServiceClaims } from '@endo/service-kit';
import type { SessionTable } from '@endo/session-store';
import {
  APP_LOCK_IDLE_MS,
  CONSENT_PENDING_ABSOLUTE_MS,
  PATIENT_ABSOLUTE_MS,
  PATIENT_IDLE_MS,
  type ConsentPendingSession,
  type ConsentSessions,
  type Session,
  type SessionResolver,
} from './sessions.ts';

interface PatientDoc {
  readonly claims: ServiceClaims;
  readonly authenticatedAt: number;
  readonly appLock: boolean;
  readonly locked: boolean;
}
interface PendingDoc {
  readonly transactionId: string;
  readonly subject: string;
}
const PATIENT = 'patient';
const PENDING = 'consent-pending';

/**
 * Durable patient sessions (spec 10.1, ADR-0021 section 12, ADR-0033), over the shared session
 * table, with the in-memory store's rules: 30 minutes idle, 12 hours absolute (60 minutes for a
 * consent-pending session), app lock after 5 minutes unused, atomic rotation at activation that
 * keeps the time of her first passkey.
 */
export class PostgresPatientSessions implements SessionResolver, ConsentSessions {
  readonly #table: SessionTable;

  constructor(table: SessionTable) {
    this.#table = table;
  }

  async resolve(token: string): Promise<Session | null> {
    const s = await this.#table.get<PatientDoc>(token, PATIENT);
    if (!s) return null;
    let doc = s.doc;
    // Unused for 5 minutes with app lock on: locked until she signs in again (RISK-S02).
    if (doc.appLock && !doc.locked && Date.now() - s.lastSeenBefore > APP_LOCK_IDLE_MS) {
      doc = { ...doc, locked: true };
      await this.#table.patch(token, doc);
    }
    return {
      claims: doc.claims,
      createdAt: s.createdAt,
      lastSeenAt: Date.now(),
      authenticatedAt: doc.authenticatedAt,
      appLock: doc.appLock,
      locked: doc.locked,
    };
  }

  revoke(token: string): Promise<void> {
    return this.#table.remove(token);
  }

  async setAppLock(token: string, enabled: boolean): Promise<boolean> {
    const s = await this.resolve(token);
    if (!s || s.locked) return false;
    await this.#table.patch(token, {
      claims: s.claims,
      authenticatedAt: s.authenticatedAt,
      appLock: enabled,
      locked: false,
    } satisfies PatientDoc);
    return true;
  }

  async lock(token: string): Promise<void> {
    const s = await this.resolve(token);
    if (s?.appLock && !s.locked)
      await this.#table.patch(token, {
        claims: s.claims,
        authenticatedAt: s.authenticatedAt,
        appLock: true,
        locked: true,
      } satisfies PatientDoc);
  }

  createConsentPending(transactionId: string, subject: string): Promise<string> {
    return this.#table.insert<PendingDoc>({
      kind: PENDING,
      doc: { transactionId, subject },
      idleMs: PATIENT_IDLE_MS,
      absoluteMs: CONSENT_PENDING_ABSOLUTE_MS,
    });
  }

  async consentPending(token: string): Promise<ConsentPendingSession | null> {
    const s = await this.#table.get<PendingDoc>(token, PENDING);
    return s ? { ...s.doc, createdAt: s.createdAt, lastSeenAt: Date.now() } : null;
  }

  rotate(
    token: string,
    transactionId: string,
    subject: string,
    claims: ServiceClaims,
  ): Promise<string | null> {
    return this.#table.rotate<PendingDoc, PatientDoc>(token, PENDING, (old) =>
      old.doc.transactionId === transactionId && old.doc.subject === subject
        ? {
            kind: PATIENT,
            // Her passkey was used when the consent-pending session was made, not now.
            doc: { claims, authenticatedAt: old.createdAt, appLock: false, locked: false },
            idleMs: PATIENT_IDLE_MS,
            absoluteMs: PATIENT_ABSOLUTE_MS,
          }
        : null,
    );
  }

  createPatient(claims: ServiceClaims, appLock = false): Promise<string> {
    return this.#table.insert<PatientDoc>({
      kind: PATIENT,
      doc: { claims, authenticatedAt: Date.now(), appLock, locked: false },
      idleMs: PATIENT_IDLE_MS,
      absoluteMs: PATIENT_ABSOLUTE_MS,
    });
  }
}
