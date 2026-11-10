import type { Kysely, Selectable, Transaction } from 'kysely';
import type { IdentityDatabase } from '@endo/identity-store';
import type { SealedCode } from './code.ts';
import {
  ENROLMENT_STATUSES,
  transition,
  type CancelReason,
  type ConsentDecisions,
  type EnrolmentEvent,
  type EnrolmentStatus,
  type EnrolmentTransaction,
  type RefusalReason,
} from './state-machine.ts';

/** An audit event queued in the identity outbox (opaque ids and codes only; spec 2.6). */
export type OutboxEvent = Readonly<Record<string, unknown>> & { readonly id: string };

/** A stored transaction with what only the coordinator needs besides the state itself. */
export interface StoredTransaction {
  readonly tx: EnrolmentTransaction;
  readonly bindingHash: string;
  /** Present only while awaiting confirmation (ADR-0021 section 3). */
  readonly code: SealedCode | null;
  readonly version: number;
}

export type ApplyResult =
  | { readonly ok: true; readonly changed: boolean; readonly tx: EnrolmentTransaction }
  | { readonly ok: false; readonly reason: RefusalReason | 'not-found' };

/**
 * Persists enrolment transactions (ADR-0021 section 10). Every change goes through the pure state
 * machine, under a row lock, and is written together with its audit event in one transaction.
 */
export class PostgresEnrolmentStore {
  readonly #db: Kysely<IdentityDatabase>;

  constructor(db: Kysely<IdentityDatabase>) {
    this.#db = db;
  }

  /** Stores a new transaction (from startTransaction) with its browser binding and code. */
  async create(
    tx: EnrolmentTransaction,
    binding: { bindingHash: string; code: SealedCode },
    audit: OutboxEvent,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('enrolment_transaction')
        .values({
          id: tx.id,
          invitation_id: tx.invitationId,
          org_id: tx.orgId,
          status: tx.status,
          started_at: tx.startedAt,
          expires_at: tx.expiresAt,
          state_deadline: tx.stateDeadline,
          binding_hash: binding.bindingHash,
          code_wrapped_key: binding.code.wrappedKey,
          code_mac: binding.code.mac,
        })
        .execute();
      await queue(trx, audit);
    });
  }

  async get(id: string): Promise<StoredTransaction | null> {
    const row = await this.#db
      .selectFrom('enrolment_transaction')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toStored(row) : null;
  }

  /**
   * Applies one event. The row is locked, the state machine decides, and a change is written with
   * its audit event (built from the before and after states) in the same transaction. A refusal
   * or a change-free repeat writes nothing. `clock` is read after the lock is held, so a request
   * that waited for the lock is judged at the time it actually runs (deadlines).
   *
   * The database refuses the change unless its audit event names this transaction as its
   * resource (`resource.id`).
   */
  apply(
    id: string,
    event: EnrolmentEvent,
    clock: () => Date,
    audit: (before: EnrolmentTransaction, after: EnrolmentTransaction) => OutboxEvent,
  ): Promise<ApplyResult> {
    return this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('enrolment_transaction')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { ok: false, reason: 'not-found' } as const;
      const before = toStored(row).tx;
      const result = transition(before, event, clock());
      if (!result.ok || !result.changed) return result;
      const after = result.tx;
      await trx
        .updateTable('enrolment_transaction')
        .set({
          status: after.status,
          state_deadline: after.stateDeadline,
          // The code is never needed (or shown) again once confirmation is over (section 3).
          ...(after.status === 'awaiting-confirmation'
            ? {}
            : { code_wrapped_key: null, code_mac: null }),
          provisional_subject: after.provisionalSubject,
          decisions:
            after.decisions === null ? null : JSON.stringify(encodeDecisions(after.decisions)),
          person_id: after.personId,
          patient_id: after.patientId,
          cancel_requested: after.cancelRequested,
          cancel_reason: after.cancelReason,
          activation_step: after.activationStep,
        })
        .where('id', '=', id)
        .execute();
      await queue(trx, audit(before, after));
      return result;
    });
  }

  /** Pre-claim transactions whose deadline has passed, oldest first, for the deadline sweep. */
  async listOverdue(now: Date, limit = 100): Promise<string[]> {
    const rows = await this.#db
      .selectFrom('enrolment_transaction')
      .select('id')
      .where('state_deadline', '<=', now)
      .where('status', 'in', [
        'awaiting-confirmation',
        'confirmed',
        'redeemed',
        'credential-committed',
        'consent-pending',
      ])
      .orderBy('state_deadline')
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }
}

async function queue(trx: Transaction<IdentityDatabase>, event: OutboxEvent): Promise<void> {
  await trx
    .insertInto('audit_outbox')
    .values({ id: event.id, event: JSON.stringify(event) })
    .execute();
}

type Row = Selectable<IdentityDatabase['enrolment_transaction']>;

function toStored(row: Row): StoredTransaction {
  const status = row.status as EnrolmentStatus;
  if (!ENROLMENT_STATUSES.includes(status)) throw new Error('unknown enrolment status');
  return {
    tx: {
      id: row.id,
      invitationId: row.invitation_id,
      orgId: row.org_id,
      status,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      stateDeadline: row.state_deadline,
      provisionalSubject: row.provisional_subject,
      decisions: row.decisions === null ? null : decodeDecisions(row.decisions),
      personId: row.person_id,
      patientId: row.patient_id,
      cancelRequested: row.cancel_requested as CancelReason | null,
      cancelReason: row.cancel_reason as CancelReason | null,
      activationStep: row.activation_step as 0 | 1 | 2 | 3,
    },
    bindingHash: row.binding_hash,
    code:
      row.code_wrapped_key !== null && row.code_mac !== null
        ? { wrappedKey: row.code_wrapped_key, mac: row.code_mac }
        : null,
    version: row.version,
  };
}

type StoredChoice = { status: 'granted' | 'declined'; version: number; decided_at: string };

function encodeDecisions(d: ConsentDecisions): Record<string, StoredChoice> {
  const one = (c: ConsentDecisions['self_tracking']): StoredChoice => ({
    status: c.status,
    version: c.version,
    decided_at: c.decidedAt.toISOString(),
  });
  return {
    self_tracking: one(d.self_tracking),
    share_with_care_team: one(d.share_with_care_team),
    research_deidentified: one(d.research_deidentified),
    org_aggregate_reporting: one(d.org_aggregate_reporting),
  };
}

function decodeDecisions(raw: unknown): ConsentDecisions {
  const stored = new Map(Object.entries(raw as Record<string, StoredChoice>));
  const choice = (p: string) => {
    const c = stored.get(p);
    if (!c) throw new Error('stored consent decisions are incomplete');
    return { status: c.status, version: c.version, decidedAt: new Date(c.decided_at) };
  };
  return {
    self_tracking: choice('self_tracking'),
    share_with_care_team: choice('share_with_care_team'),
    research_deidentified: choice('research_deidentified'),
    org_aggregate_reporting: choice('org_aggregate_reporting'),
  };
}
