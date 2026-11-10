import type { Kysely, Selectable, Transaction } from 'kysely';
import type { IdentityDatabase } from '@endo/identity-store';
import type { CodeBinding, SealedCode } from './code.ts';
import {
  ENROLMENT_STATUSES,
  isOverdue,
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

/** Every event except confirmation, which only a matching code can cause (`confirmByCode`). */
export type ApplicableEvent = Exclude<EnrolmentEvent, { readonly type: 'confirm' }>;

/** Wrong entries allowed per invitation; the database enforces the same number (migration 0004). */
export const WRONG_CODE_LIMIT = 5;

/** What the clinician typed, for the invitation they selected (ADR-0021 section 3). */
export interface CodeEntry {
  readonly invitationId: string;
  /** The clinician's organisation; only that organisation's transactions are candidates. */
  readonly orgId: string;
  readonly code: string;
}

/** Audit events of a code check, built by the caller, who knows the clinician and attestation. */
export type CodeCheckAudit =
  | {
      readonly kind: 'confirmed' | 'cancelled';
      readonly before: EnrolmentTransaction;
      readonly after: EnrolmentTransaction;
    }
  | { readonly kind: 'wrong-code'; readonly invitationId: string; readonly wrongAttempts: number }
  | { readonly kind: 'locked'; readonly invitationId: string; readonly lockedUntil: Date };

export type CodeCheckResult =
  | {
      readonly outcome: 'confirmed';
      readonly tx: EnrolmentTransaction;
      readonly cancelled: readonly string[];
    }
  | { readonly outcome: 'wrong'; readonly remaining: number }
  /** Locked now (`cancelled` lists what the lock ended) or already locked (`cancelled` empty). */
  | {
      readonly outcome: 'locked';
      readonly lockedUntil: Date;
      readonly cancelled: readonly string[];
    };

/** A pending code of the same invitation, which a new code must differ from. */
export interface PendingCode {
  readonly binding: CodeBinding;
  readonly sealed: SealedCode;
}

export type CodeMatcher = (
  code: string,
  binding: CodeBinding,
  sealed: SealedCode,
) => Promise<boolean>;

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

  /**
   * Stores a new transaction (from startTransaction) with its browser binding, and returns its
   * code. The code is drawn by `issue` while the invitation's guard row is held, from the codes
   * of the transactions then awaiting confirmation, so concurrent starts on one invitation can
   * never get the same code (ADR-0021 section 3). Refused while the invitation is locked.
   */
  async create(
    tx: EnrolmentTransaction,
    bindingHash: string,
    issue: (pending: readonly PendingCode[]) => Promise<{ code: string; sealed: SealedCode }>,
    audit: OutboxEvent,
  ): Promise<{ code: string }> {
    return this.#db.transaction().execute(async (trx) => {
      await trx
        .insertInto('enrolment_invitation_guard')
        .values({ invitation_id: tx.invitationId })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .selectFrom('enrolment_invitation_guard')
        .select('invitation_id')
        .where('invitation_id', '=', tx.invitationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pending = (await awaiting(trx, tx.invitationId)).flatMap((s) =>
        s.code === null
          ? []
          : [
              {
                binding: { invitationId: tx.invitationId, transactionId: s.tx.id },
                sealed: s.code,
              },
            ],
      );
      const { code, sealed } = await issue(pending);
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
          binding_hash: bindingHash,
          code_wrapped_key: sealed.wrappedKey,
          code_mac: sealed.mac,
        })
        .execute();
      await queue(trx, audit);
      return { code };
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
    event: ApplicableEvent,
    clock: () => Date,
    audit: (before: EnrolmentTransaction, after: EnrolmentTransaction) => OutboxEvent,
  ): Promise<ApplyResult> {
    // Checked at run time too: nothing confirms a transaction without its code check.
    if ((event as EnrolmentEvent).type === 'confirm')
      return Promise.reject(new Error('confirmation goes through confirmByCode'));
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
      await write(trx, result.tx, audit(before, result.tx));
      return result;
    });
  }

  /**
   * The clinician's code check (ADR-0021 section 3), in one database transaction serialised on
   * the invitation's guard row (lock order everywhere: guard row, then transaction rows):
   * - locked invitation: refused, nothing counted;
   * - the code matches a live transaction of this organisation awaiting confirmation: it is
   *   confirmed (its code cleared) and its siblings are cancelled (`sibling-confirmed`);
   * - otherwise one wrong entry is counted; the fifth locks the invitation for 15 minutes and
   *   cancels every transaction awaiting confirmation (`code-lockout`).
   * Every candidate is compared, so timing does not tell which one matched. A transaction past
   * its deadline is not a candidate. The database enforces the counter and the lock.
   *
   * The API's reservation of the invitation follows the confirmation (section 6); if it is
   * refused, the coordinator cancels the confirmed transaction.
   */
  confirmByCode(
    entry: CodeEntry,
    matches: CodeMatcher,
    clock: () => Date,
    audit: (e: CodeCheckAudit) => OutboxEvent,
  ): Promise<CodeCheckResult> {
    return this.#db.transaction().execute(async (trx): Promise<CodeCheckResult> => {
      await trx
        .insertInto('enrolment_invitation_guard')
        .values({ invitation_id: entry.invitationId })
        .onConflict((oc) => oc.doNothing())
        .execute();
      const guard = await trx
        .selectFrom('enrolment_invitation_guard')
        .select(['wrong_attempts', 'locked_until'])
        .where('invitation_id', '=', entry.invitationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const now = clock();
      if (guard.locked_until !== null && guard.locked_until > now)
        return { outcome: 'locked', lockedUntil: guard.locked_until, cancelled: [] };

      // Every row this check may change is locked now, before the guard is updated, so a
      // lockout never waits for a row while holding the guard (no lock cycle with apply()).
      const all = await awaiting(trx, entry.invitationId);
      const pending = all.filter((s) => s.tx.orgId === entry.orgId);
      const hits: StoredTransaction[] = [];
      for (const s of pending) {
        if (s.code === null || isOverdue(s.tx, now)) continue;
        const binding = { invitationId: entry.invitationId, transactionId: s.tx.id };
        if (await matches(entry.code, binding, s.code)) hits.push(s);
      }
      // Codes of one invitation are distinct (create), so two matches mean something is wrong:
      // confirm neither, and change nothing.
      if (hits.length > 1) throw new Error('an enrolment code matched more than one transaction');
      const match = hits[0] ?? null;

      if (match !== null) {
        const before = match.tx;
        const confirmed = transition(before, { type: 'confirm' }, now);
        if (!confirmed.ok) throw new Error('a matching transaction could not be confirmed');
        await write(trx, confirmed.tx, audit({ kind: 'confirmed', before, after: confirmed.tx }));
        const siblings = pending.filter((s) => s.tx.id !== before.id);
        const cancelled = await cancelAll(trx, siblings, 'sibling-confirmed', now, audit);
        return { outcome: 'confirmed', tx: confirmed.tx, cancelled };
      }

      const counted = await trx
        .updateTable('enrolment_invitation_guard')
        .set((eb) => ({ wrong_attempts: eb('wrong_attempts', '+', 1) }))
        .where('invitation_id', '=', entry.invitationId)
        .returning(['wrong_attempts', 'locked_until'])
        .executeTakeFirstOrThrow();
      const lockedUntil = counted.locked_until;
      if (lockedUntil === null || lockedUntil.getTime() === guard.locked_until?.getTime()) {
        const wrongAttempts = counted.wrong_attempts;
        await queue(
          trx,
          audit({ kind: 'wrong-code', invitationId: entry.invitationId, wrongAttempts }),
        );
        return { outcome: 'wrong', remaining: WRONG_CODE_LIMIT - wrongAttempts };
      }
      // The fifth wrong entry: the database has locked the invitation. Every transaction of it
      // awaiting confirmation ends, whatever its organisation; the database checks none is left.
      await queue(trx, audit({ kind: 'locked', invitationId: entry.invitationId, lockedUntil }));
      const cancelled = await cancelAll(trx, all, 'code-lockout', now, audit);
      return { outcome: 'locked', lockedUntil, cancelled };
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

/** Writes a transition decided by the state machine, with its audit event. */
async function write(
  trx: Transaction<IdentityDatabase>,
  after: EnrolmentTransaction,
  event: OutboxEvent,
): Promise<void> {
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
      decisions: after.decisions === null ? null : JSON.stringify(encodeDecisions(after.decisions)),
      person_id: after.personId,
      patient_id: after.patientId,
      cancel_requested: after.cancelRequested,
      cancel_reason: after.cancelReason,
      activation_step: after.activationStep,
    })
    .where('id', '=', after.id)
    .execute();
  await queue(trx, event);
}

/** Transactions of an invitation awaiting confirmation, locked in id order. */
async function awaiting(
  trx: Transaction<IdentityDatabase>,
  invitationId: string,
): Promise<StoredTransaction[]> {
  const rows = await trx
    .selectFrom('enrolment_transaction')
    .selectAll()
    .where('invitation_id', '=', invitationId)
    .where('status', '=', 'awaiting-confirmation')
    .orderBy('id')
    .forUpdate()
    .execute();
  return rows.map(toStored);
}

async function cancelAll(
  trx: Transaction<IdentityDatabase>,
  pending: readonly StoredTransaction[],
  reason: CancelReason,
  now: Date,
  audit: (e: CodeCheckAudit) => OutboxEvent,
): Promise<string[]> {
  const cancelled: string[] = [];
  for (const { tx: before } of pending) {
    const r = transition(before, { type: 'cancel', reason }, now);
    if (!r.ok || !r.changed) continue;
    await write(trx, r.tx, audit({ kind: 'cancelled', before, after: r.tx }));
    cancelled.push(before.id);
  }
  return cancelled;
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
