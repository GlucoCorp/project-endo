import { sql, type Kysely, type Transaction } from 'kysely';
import { withOrg } from './org-scope.ts';
import type { ClinicalDatabase } from './schema.ts';

/** Audit event (opaque ids and codes only), queued in the same transaction when something changes. */
export type AuditEvent = Readonly<Record<string, unknown>> & { readonly id: string };

/**
 * An invitation's state, as the enrolment coordinator needs it (ADR-0021 section 6). `missing`
 * means no such invitation in that organisation. `reservedBy` is the coordinator transaction that
 * holds it, kept after a claim or revocation as a record.
 */
export type InvitationState =
  | { readonly status: 'missing' }
  | { readonly status: 'live' | 'expired' | 'revoked'; readonly reservedBy: string | null }
  | { readonly status: 'claimed'; readonly reservedBy: string; readonly patientId: string };

export interface ReservationRequest {
  readonly orgId: string;
  readonly invitationId: string;
  /** The coordinator's enrolment transaction id. */
  readonly transactionId: string;
  readonly auditEvent: AuditEvent;
}

export interface ClaimRequest extends ReservationRequest {
  /** New pseudonymous patient record, created in the same database transaction as the claim. */
  readonly patientId: string;
  /** Opaque identity reference: the identity-vault person id the coordinator will create next. */
  readonly identityRef: string;
}

/**
 * `done`: the request now holds (newly, or because an identical request already succeeded; then
 * `changed` is false and no audit event is written). `refused`: it cannot hold; `state` says why.
 */
export type ReservationOutcome =
  | { readonly outcome: 'done'; readonly changed: boolean; readonly state: InvitationState }
  | { readonly outcome: 'refused'; readonly state: InvitationState };

/**
 * The invitation row is the single serialisation point for enrolment (ADR-0021 section 6). Every
 * operation locks the row, decides from its current state, and makes at most one conditional
 * update, so concurrent reserve, release, revoke and claim are ordered by the lock. Each is
 * idempotent per transaction, and the row itself is the durable record of the result.
 */
export interface InvitationReservationStore {
  state(orgId: string, invitationId: string): Promise<InvitationState>;
  /** Live, not expired, and unreserved (or already reserved by this transaction). */
  reserve(r: ReservationRequest): Promise<ReservationOutcome>;
  /**
   * Ends this transaction's hold for good: clears its reservation if the invitation is not final,
   * and records a fence so the transaction can never reserve again, even if a delayed reserve
   * arrives later. Never touches another transaction's reservation.
   */
  release(r: ReservationRequest): Promise<ReservationOutcome>;
  /** Makes the invitation final unless it is already claimed. Wins over any reservation. */
  revoke(r: Omit<ReservationRequest, 'transactionId'>): Promise<ReservationOutcome>;
  /** Creates the patient record and claims the invitation reserved by this transaction. */
  claim(r: ClaimRequest): Promise<ReservationOutcome>;
}

type Row = {
  reserved_by: string | null;
  patient_id: string | null;
  claimed: boolean;
  revoked: boolean;
  expired: boolean;
};

function toState(row: Row | undefined): InvitationState {
  if (!row) return { status: 'missing' };
  if (row.claimed && row.reserved_by && row.patient_id)
    return { status: 'claimed', reservedBy: row.reserved_by, patientId: row.patient_id };
  const status = row.revoked ? 'revoked' : row.expired ? 'expired' : 'live';
  return { status, reservedBy: row.reserved_by };
}

export class PostgresInvitationReservationStore implements InvitationReservationStore {
  readonly #db: Kysely<ClinicalDatabase>;

  constructor(db: Kysely<ClinicalDatabase>) {
    this.#db = db;
  }

  state(orgId: string, invitationId: string): Promise<InvitationState> {
    return withOrg(this.#db, orgId, async (trx) => toState(await read(trx, invitationId, false)));
  }

  reserve(r: ReservationRequest): Promise<ReservationOutcome> {
    return this.#locked(r.orgId, r.invitationId, async (trx, state) => {
      if (state.status !== 'live') return { outcome: 'refused', state };
      if (state.reservedBy === r.transactionId) return { outcome: 'done', changed: false, state };
      if (state.reservedBy !== null || (await fenced(trx, r.transactionId)))
        return { outcome: 'refused', state };
      await update(trx, r.invitationId, { reserved_by: r.transactionId, reserved_at: new Date() });
      return changed(trx, r, { status: 'live', reservedBy: r.transactionId });
    });
  }

  release(r: ReservationRequest): Promise<ReservationOutcome> {
    return this.#locked(r.orgId, r.invitationId, async (trx, state) => {
      if (state.status === 'missing') return { outcome: 'refused', state };
      // A claim that already won stands: the caller must go on to activation, not clean up.
      if (state.status === 'claimed' && state.reservedBy === r.transactionId)
        return { outcome: 'refused', state };
      const fence = await trx
        .insertInto('enrolment_reservation_fence')
        .values({ transaction_id: r.transactionId, org_id: r.orgId, invitation_id: r.invitationId })
        .onConflict((oc) => oc.column('transaction_id').doNothing())
        .executeTakeFirst();
      // Still holding: live or expired, reserved by this transaction (a claimed hold returned above).
      const held: InvitationState | null =
        (state.status === 'live' || state.status === 'expired') &&
        state.reservedBy === r.transactionId
          ? { status: state.status, reservedBy: null }
          : null;
      if (held) await update(trx, r.invitationId, { reserved_by: null, reserved_at: null });
      if (!held && Number(fence.numInsertedOrUpdatedRows ?? 0) === 0)
        return { outcome: 'done', changed: false, state };
      return changed(trx, r, held ?? state);
    });
  }

  revoke(r: Omit<ReservationRequest, 'transactionId'>): Promise<ReservationOutcome> {
    return this.#locked(r.orgId, r.invitationId, async (trx, state) => {
      if (state.status === 'missing' || state.status === 'claimed')
        return { outcome: 'refused', state };
      if (state.status === 'revoked') return { outcome: 'done', changed: false, state };
      await update(trx, r.invitationId, { revoked_at: new Date() });
      return changed(trx, r, { status: 'revoked', reservedBy: state.reservedBy });
    });
  }

  claim(r: ClaimRequest): Promise<ReservationOutcome> {
    return this.#locked(r.orgId, r.invitationId, async (trx, state) => {
      if (state.status === 'claimed' && state.reservedBy === r.transactionId) {
        // A retry must ask for exactly what was claimed; anything else is a different request.
        const same =
          state.patientId === r.patientId &&
          (await identityRefOf(trx, state.patientId)) === r.identityRef;
        return same ? { outcome: 'done', changed: false, state } : { outcome: 'refused', state };
      }
      if (state.status !== 'live' || state.reservedBy !== r.transactionId)
        return { outcome: 'refused', state };
      await trx
        .insertInto('patient_record')
        .values({ id: r.patientId, org_id: r.orgId, identity_ref: r.identityRef })
        .execute();
      await update(trx, r.invitationId, { claimed_at: new Date(), patient_id: r.patientId });
      return changed(trx, r, {
        status: 'claimed',
        reservedBy: r.transactionId,
        patientId: r.patientId,
      });
    });
  }

  #locked(
    orgId: string,
    invitationId: string,
    fn: (trx: Transaction<ClinicalDatabase>, state: InvitationState) => Promise<ReservationOutcome>,
  ): Promise<ReservationOutcome> {
    return withOrg(this.#db, orgId, async (trx) =>
      fn(trx, toState(await read(trx, invitationId, true))),
    );
  }
}

function read(
  trx: Transaction<ClinicalDatabase>,
  invitationId: string,
  lock: boolean,
): Promise<Row | undefined> {
  const q = trx
    .selectFrom('enrolment_invitation')
    .select([
      'reserved_by',
      'patient_id',
      sql<boolean>`claimed_at IS NOT NULL`.as('claimed'),
      sql<boolean>`revoked_at IS NOT NULL`.as('revoked'),
      // The database clock decides expiry, as the forward-only trigger does.
      sql<boolean>`expires_at <= clock_timestamp()`.as('expired'),
    ])
    .where('id', '=', invitationId);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

async function fenced(trx: Transaction<ClinicalDatabase>, transactionId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('enrolment_reservation_fence')
    .select('transaction_id')
    .where('transaction_id', '=', transactionId)
    .executeTakeFirst();
  return row !== undefined;
}

async function identityRefOf(
  trx: Transaction<ClinicalDatabase>,
  patientId: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('patient_record')
    .select('identity_ref')
    .where('id', '=', patientId)
    .executeTakeFirst();
  return row?.identity_ref;
}

async function update(
  trx: Transaction<ClinicalDatabase>,
  invitationId: string,
  // Times are placeholders: the trigger replaces them with the database clock.
  set: Partial<
    Pick<
      ClinicalDatabase['enrolment_invitation'],
      'reserved_by' | 'reserved_at' | 'claimed_at' | 'patient_id' | 'revoked_at'
    >
  >,
): Promise<void> {
  await trx.updateTable('enrolment_invitation').set(set).where('id', '=', invitationId).execute();
}

async function changed(
  trx: Transaction<ClinicalDatabase>,
  r: { auditEvent: AuditEvent },
  state: InvitationState,
): Promise<ReservationOutcome> {
  await trx
    .insertInto('audit_outbox')
    .values({ id: r.auditEvent.id, event: JSON.stringify(r.auditEvent) })
    .execute();
  return { outcome: 'done', changed: true, state };
}
