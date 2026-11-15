import type { Kysely } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

type Audit = Readonly<Record<string, unknown>> & { readonly id: string };

export interface DeletionStatus {
  readonly id: string;
  readonly requestedAt: Date;
  readonly dueAt: Date;
  readonly cancelledAt: Date | null;
  readonly erasedAt: Date | null;
}

/**
 * Account deletion (REQ-009): she asks, she has 14 days to change her mind, then the job erases
 * her clinical data (patient_erase, migration 0014: her key shredded first) and her identity
 * record (through the identity service).
 */
export interface DeletionStore {
  /** Her open request, made now if there is none (one open request per patient). */
  request(r: {
    readonly id: string;
    readonly orgId: string;
    readonly patientId: string;
    readonly identityRef: string;
    readonly auditEvent: Audit;
  }): Promise<DeletionStatus>;
  status(orgId: string, patientId: string): Promise<DeletionStatus | null>;
  /** Cancels her open request during the grace period; false if there is none. */
  cancel(orgId: string, patientId: string, auditEvent: Audit): Promise<boolean>;
  /** Patients whose 14 days are over (cross-organisation, ids only). */
  due(): Promise<{ patientId: string; orgId: string }[]>;
  /** Erases one patient's clinical data, only if her request is due and not cancelled. */
  erase(orgId: string, patientId: string, auditEvent: Audit): Promise<boolean>;
  /** Erased clinically, identity not yet: the job retries the identity service. */
  identityPending(): Promise<{ id: string; orgId: string; identityRef: string }[]>;
  markIdentityErased(orgId: string, id: string): Promise<void>;
  /** Her identity reference (for the request); null if she has no record. */
  identityRefOf(orgId: string, patientId: string): Promise<string | null>;
}

const toStatus = (r: {
  id: string;
  requested_at: Date;
  due_at: Date;
  cancelled_at: Date | null;
  erased_at: Date | null;
}): DeletionStatus => ({
  id: r.id,
  requestedAt: r.requested_at,
  dueAt: r.due_at,
  cancelledAt: r.cancelled_at,
  erasedAt: r.erased_at,
});

export class PostgresDeletionStore implements DeletionStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  request(r: Parameters<DeletionStore['request']>[0]): Promise<DeletionStatus> {
    return withOrg(this.#db, r.orgId, async (trx) => {
      const open = await trx
        .selectFrom('deletion_request')
        .select(['id', 'requested_at', 'due_at', 'cancelled_at', 'erased_at'])
        .where('patient_id', '=', r.patientId)
        .where('cancelled_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (open) return toStatus(open);
      const row = await trx
        .insertInto('deletion_request')
        .values({ id: r.id, org_id: r.orgId, patient_id: r.patientId, identity_ref: r.identityRef })
        .returning(['id', 'requested_at', 'due_at', 'cancelled_at', 'erased_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('audit_outbox')
        .values({ id: r.auditEvent.id, event: JSON.stringify(r.auditEvent) })
        .execute();
      return toStatus(row);
    });
  }

  status(orgId: string, patientId: string): Promise<DeletionStatus | null> {
    return withOrg(this.#db, orgId, async (trx) => {
      const row = await trx
        .selectFrom('deletion_request')
        .select(['id', 'requested_at', 'due_at', 'cancelled_at', 'erased_at'])
        .where('patient_id', '=', patientId)
        .orderBy('requested_at', 'desc')
        .executeTakeFirst();
      return row ? toStatus(row) : null;
    });
  }

  cancel(orgId: string, patientId: string, auditEvent: Audit): Promise<boolean> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .updateTable('deletion_request')
        .set({ cancelled_at: new Date() })
        .where('patient_id', '=', patientId)
        .where('cancelled_at', 'is', null)
        .where('erased_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return false;
      await trx
        .insertInto('audit_outbox')
        .values({ id: auditEvent.id, event: JSON.stringify(auditEvent) })
        .execute();
      return true;
    });
  }

  async due() {
    const rows = await this.#db
      .selectFrom((eb) => eb.fn<{ patient_id: string; org_id: string }>('deletion_due', []).as('d'))
      .select(['d.patient_id', 'd.org_id'])
      .execute();
    return rows.map((r) => ({ patientId: r.patient_id, orgId: r.org_id }));
  }

  erase(orgId: string, patientId: string, auditEvent: Audit): Promise<boolean> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .selectNoFrom((eb) =>
          eb.fn<boolean>('patient_erase', [eb.val(orgId), eb.val(patientId)]).as('erased'),
        )
        .executeTakeFirstOrThrow();
      if (!r.erased) return false;
      // The audit event names the request's patient id only (opaque, no PHI): REQ-009.
      await trx
        .insertInto('audit_outbox')
        .values({ id: auditEvent.id, event: JSON.stringify(auditEvent) })
        .execute();
      return true;
    });
  }

  async identityPending() {
    const rows = await this.#db
      .selectFrom((eb) =>
        eb
          .fn<{ id: string; org_id: string; identity_ref: string }>('deletion_identity_pending', [])
          .as('p'),
      )
      .select(['p.id', 'p.org_id', 'p.identity_ref'])
      .execute();
    return rows.map((r) => ({ id: r.id, orgId: r.org_id, identityRef: r.identity_ref }));
  }

  markIdentityErased(orgId: string, id: string): Promise<void> {
    return withOrg(this.#db, orgId, async (trx) => {
      await trx
        .updateTable('deletion_request')
        .set({ identity_erased_at: new Date() })
        .where('id', '=', id)
        .where('identity_erased_at', 'is', null)
        .execute();
    });
  }

  identityRefOf(orgId: string, patientId: string): Promise<string | null> {
    return withOrg(this.#db, orgId, async (trx) => {
      const r = await trx
        .selectFrom('patient_record')
        .select('identity_ref')
        .where('id', '=', patientId)
        .executeTakeFirst();
      return r?.identity_ref ?? null;
    });
  }
}
