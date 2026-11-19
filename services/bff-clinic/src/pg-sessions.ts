import { randomBytes } from 'node:crypto';
import type { SealedValue } from '@endo/crypto';
import type { SessionTable } from '@endo/session-store';
import type { Membership } from './resolve.ts';
import {
  CLINIC_ABSOLUTE_MS,
  CLINIC_IDLE_MS,
  type ClinicSession,
  type ClinicSessionStore,
  type NewSession,
} from './sessions.ts';

type Doc = Omit<ClinicSession, 'createdAt' | 'lastSeenAt'>;
const KIND = 'clinic';
const random = () => randomBytes(32).toString('base64url');

/**
 * Durable clinician sessions (ADR-0019 section 5, ADR-0033), over the shared session table:
 * the same rules as the in-memory store (fresh id at sign-in, rotation on activation with the
 * absolute deadline kept, background reads never extend the idle time), across replicas.
 */
export class PostgresClinicSessions implements ClinicSessionStore {
  readonly #table: SessionTable;

  constructor(table: SessionTable) {
    this.#table = table;
  }

  create(s: NewSession): Promise<string> {
    const doc: Doc = {
      personId: s.personId,
      issuer: s.issuer,
      subject: s.subject,
      sid: s.sid,
      idToken: s.idToken,
      refresh: s.refresh,
      validatedAt: Date.now(),
      state: 'pending-org',
      candidates: [...s.memberships],
      active: null,
      csrfToken: random(),
    };
    return this.#table.insert({
      kind: KIND,
      doc,
      idleMs: CLINIC_IDLE_MS,
      absoluteMs: CLINIC_ABSOLUTE_MS,
      issuer: s.issuer,
      sid: s.sid,
      subject: s.subject,
    });
  }

  activate(
    token: string,
    membership: Membership,
    opts: { touch: boolean } = { touch: true },
  ): Promise<string | null> {
    return this.#table.rotate<Doc, Doc>(token, KIND, (old) => ({
      kind: KIND,
      doc: { ...old.doc, state: 'active', active: membership, csrfToken: random() },
      idleMs: CLINIC_IDLE_MS,
      absoluteMs: CLINIC_ABSOLUTE_MS,
      issuer: old.doc.issuer,
      sid: old.doc.sid,
      subject: old.doc.subject,
      createdAt: old.createdAt,
      ...(opts.touch ? {} : { lastSeenAt: old.lastSeenBefore }),
    }));
  }

  async resolve(
    token: string,
    opts: { touch: boolean } = { touch: true },
  ): Promise<ClinicSession | null> {
    const s = await this.#table.get<Doc>(token, KIND, opts.touch);
    if (!s) return null;
    return {
      ...s.doc,
      createdAt: s.createdAt,
      lastSeenAt: opts.touch ? Date.now() : s.lastSeenBefore,
    };
  }

  async recordRevalidation(token: string, refresh: SealedValue): Promise<void> {
    const s = await this.#table.get<Doc>(token, KIND, false);
    if (s) await this.#table.patch(token, { ...s.doc, refresh, validatedAt: Date.now() });
  }

  revoke(token: string): Promise<void> {
    return this.#table.remove(token);
  }

  revokeMatching(issuer: string, match: { sid?: string; sub?: string }): Promise<number> {
    return this.#table.removeMatching(issuer, match);
  }
}
