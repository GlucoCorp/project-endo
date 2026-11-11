import type { Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase, ConsentPurpose, ConsentStatus } from './schema.ts';

/** The current decision for one purpose (spec 13.1). */
export interface ConsentState {
  readonly purpose: ConsentPurpose;
  readonly status: ConsentStatus;
  readonly version: number;
  readonly decidedAt: Date;
}

export interface ConsentDecision {
  readonly id: string;
  readonly orgId: string;
  readonly patientId: string;
  readonly purpose: ConsentPurpose;
  readonly status: 'granted' | 'revoked';
  readonly version: number;
  /** Audit event (opaque ids and codes only), queued in the same transaction (spec 2.6). */
  readonly auditEvent: Readonly<Record<string, unknown>> & { readonly id: string };
}

export interface ConsentStore {
  /** Her current decision per purpose; purposes never decided are absent. */
  current(orgId: string, patientId: string): Promise<ConsentState[]>;
  /**
   * Records a decision and its audit event in one transaction. If the current decision already
   * has this status and version, nothing is written (a repeated request changes nothing).
   */
  record(decision: ConsentDecision): Promise<{ changed: boolean; state: ConsentState }>;
  /**
   * Her four decisions from enrolment (ADR-0021 section 10, activation step 2), in one
   * transaction, each with its audit event and the time she chose. A purpose that already has a
   * decision is left as it is, so a retried activation step changes nothing.
   */
  recordEnrolment(
    orgId: string,
    patientId: string,
    decisions: readonly EnrolmentConsent[],
  ): Promise<{ written: number }>;
}

/** One decision she made at enrolment. */
export interface EnrolmentConsent {
  readonly id: string;
  readonly purpose: ConsentPurpose;
  readonly status: 'granted' | 'declined';
  readonly version: number;
  readonly chosenAt: Date;
  readonly auditEvent: Readonly<Record<string, unknown>> & { readonly id: string };
}

export class PostgresConsentStore implements ConsentStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  current(orgId: string, patientId: string): Promise<ConsentState[]> {
    return withOrg(this.#db, orgId, async (trx) =>
      (
        await trx
          .selectFrom('consent_current')
          .select(['purpose', 'status', 'version', 'decided_at'])
          .where('patient_id', '=', patientId)
          .execute()
      ).map((r) => ({
        purpose: r.purpose,
        status: r.status,
        version: r.version,
        decidedAt: r.decided_at,
      })),
    );
  }

  recordEnrolment(
    orgId: string,
    patientId: string,
    decisions: readonly EnrolmentConsent[],
  ): Promise<{ written: number }> {
    return withOrg(this.#db, orgId, async (trx) => {
      const existing = new Set(
        (
          await trx
            .selectFrom('consent')
            .select('purpose')
            .where('patient_id', '=', patientId)
            .execute()
        ).map((r) => r.purpose),
      );
      let written = 0;
      for (const d of decisions) {
        if (existing.has(d.purpose)) continue;
        await trx
          .insertInto('consent')
          .values({
            id: d.id,
            patient_id: patientId,
            org_id: orgId,
            purpose: d.purpose,
            status: d.status,
            version: d.version,
            chosen_at: d.chosenAt,
          })
          .execute();
        await trx
          .insertInto('audit_outbox')
          .values({ id: d.auditEvent.id, event: JSON.stringify(d.auditEvent) })
          .execute();
        written += 1;
      }
      return { written };
    });
  }

  record(d: ConsentDecision): Promise<{ changed: boolean; state: ConsentState }> {
    return withOrg(this.#db, d.orgId, async (trx) => {
      const latest = await trx
        .selectFrom('consent_current')
        .select(['status', 'version', 'decided_at'])
        .where('patient_id', '=', d.patientId)
        .where('purpose', '=', d.purpose)
        .executeTakeFirst();
      if (latest && latest.status === d.status && latest.version === d.version) {
        return {
          changed: false,
          state: {
            purpose: d.purpose,
            status: latest.status,
            version: latest.version,
            decidedAt: latest.decided_at,
          },
        };
      }
      // The database assigns order and time under a per-patient, per-purpose lock (migration 0001).
      await trx
        .insertInto('consent')
        .values({
          id: d.id,
          patient_id: d.patientId,
          org_id: d.orgId,
          purpose: d.purpose,
          status: d.status,
          version: d.version,
        })
        .execute();
      await trx
        .insertInto('audit_outbox')
        .values({ id: d.auditEvent.id, event: JSON.stringify(d.auditEvent) })
        .execute();
      const now = await trx
        .selectFrom('consent_current')
        .select(['status', 'version', 'decided_at'])
        .where('patient_id', '=', d.patientId)
        .where('purpose', '=', d.purpose)
        .executeTakeFirstOrThrow();
      return {
        changed: true,
        state: {
          purpose: d.purpose,
          status: now.status,
          version: now.version,
          decidedAt: now.decided_at,
        },
      };
    });
  }
}

/** Dev and test stand-in with the same semantics. */
export class InMemoryConsentStore implements ConsentStore {
  readonly decisions: ConsentDecision[] = [];
  readonly outbox: Readonly<Record<string, unknown>>[] = [];
  readonly #state = new Map<string, ConsentState>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  current(orgId: string, patientId: string): Promise<ConsentState[]> {
    const prefix = `${orgId}:${patientId}:`;
    return Promise.resolve(
      [...this.#state].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
    );
  }

  recordEnrolment(
    orgId: string,
    patientId: string,
    decisions: readonly EnrolmentConsent[],
  ): Promise<{ written: number }> {
    let written = 0;
    for (const d of decisions) {
      const key = `${orgId}:${patientId}:${d.purpose}`;
      if (this.#state.has(key)) continue;
      this.#state.set(key, {
        purpose: d.purpose,
        status: d.status,
        version: d.version,
        decidedAt: this.#now(),
      });
      this.outbox.push(d.auditEvent);
      written += 1;
    }
    return Promise.resolve({ written });
  }

  record(d: ConsentDecision): Promise<{ changed: boolean; state: ConsentState }> {
    const key = `${d.orgId}:${d.patientId}:${d.purpose}`;
    const latest = this.#state.get(key);
    if (latest && latest.status === d.status && latest.version === d.version) {
      return Promise.resolve({ changed: false, state: latest });
    }
    const state: ConsentState = {
      purpose: d.purpose,
      status: d.status,
      version: d.version,
      decidedAt: this.#now(),
    };
    this.#state.set(key, state);
    this.decisions.push(d);
    this.outbox.push(d.auditEvent);
    return Promise.resolve({ changed: true, state });
  }
}
