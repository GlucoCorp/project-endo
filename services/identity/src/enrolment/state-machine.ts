/**
 * The enrolment transaction state machine (ADR-0021 section 10; REQ-001, RISK-S05). Pure: it
 * decides what a transaction becomes, and the coordinator persists that with a conditional update
 * and performs the side effects. Nothing permanent exists before `claiming` succeeds.
 *
 *   awaiting-confirmation -> confirmed -> redeemed -> credential-committed -> consent-pending
 *     -> claiming -> activating -> active
 *   any state before claiming -> cancelling -> cancelled
 *   claiming + cancel -> claiming (cancel requested) -> activating | cancelling
 */

import { CONSENT_PURPOSES, type ConsentPurpose } from '@endo/authz';

export const ENROLMENT_STATUSES = [
  'awaiting-confirmation',
  'confirmed',
  'redeemed',
  'credential-committed',
  'consent-pending',
  'claiming',
  'activating',
  'active',
  'cancelling',
  'cancelled',
] as const;
export type EnrolmentStatus = (typeof ENROLMENT_STATUSES)[number];

export type CancelReason =
  | 'deadline'
  | 'patient-cancelled'
  | 'clinician-revoked'
  | 'declined'
  | 'code-lockout'
  | 'sibling-confirmed'
  | 'claim-refused';

/**
 * One consent decision as she made it: what she chose, which version of the explanation she saw,
 * and when (spec 13.1). Held unchanged until activation writes it, so a later wording change
 * cannot alter what is recorded.
 */
export interface ConsentChoice {
  readonly status: 'granted' | 'declined';
  readonly version: number;
  readonly decidedAt: Date;
}
export type ConsentDecisions = Readonly<Record<ConsentPurpose, ConsentChoice>>;

const MINUTE = 60_000;
/** Absolute deadline after Start; the browser-binding cookie expires with it (section 4). */
export const ABSOLUTE_LIFETIME_MS = 60 * MINUTE;
/** Time allowed in each state before claiming, capped by the absolute deadline. */
export const STATE_LIFETIME_MS = {
  'awaiting-confirmation': 15 * MINUTE,
  confirmed: 15 * MINUTE,
  redeemed: 15 * MINUTE,
  /** From the credential commit to her consent; consent-pending keeps this deadline. */
  'credential-committed': 30 * MINUTE,
} as const;

/** States where enrolment can still be cancelled outright and deadlines apply. */
const PRE_CLAIM: ReadonlySet<EnrolmentStatus> = new Set([
  'awaiting-confirmation',
  'confirmed',
  'redeemed',
  'credential-committed',
  'consent-pending',
]);

export interface EnrolmentTransaction {
  readonly id: string;
  readonly invitationId: string;
  readonly orgId: string;
  readonly status: EnrolmentStatus;
  readonly startedAt: Date;
  /** `startedAt` + 60 minutes. */
  readonly expiresAt: Date;
  /** Deadline of the current state, capped by `expiresAt`; null from `claiming` on. */
  readonly stateDeadline: Date | null;
  /** Keycloak subject of the provisional user, recorded at redemption. */
  readonly provisionalSubject: string | null;
  /** Her four consent decisions, held here until activation writes them (section 10). */
  readonly decisions: ConsentDecisions | null;
  /** Generated before claiming: the identity-vault person id, used as the patient's identity ref. */
  readonly personId: string | null;
  readonly patientId: string | null;
  /** Set when a cancellation arrives during `claiming`, until the clinical store resolves it. */
  readonly cancelRequested: CancelReason | null;
  readonly cancelReason: CancelReason | null;
  /** Activation steps durably done: 1 identity person and link, 2 consents, 3 Keycloak. */
  readonly activationStep: 0 | 1 | 2 | 3;
}

export type EnrolmentEvent =
  | { readonly type: 'confirm' }
  | { readonly type: 'redeem'; readonly provisionalSubject: string }
  | { readonly type: 'credential-committed' }
  /**
   * The BFF callback. `credentialCommitted` is the coordinator's reconciliation with Keycloak; it
   * matters only when the callback beats the commit notice (state `redeemed`).
   */
  | { readonly type: 'callback'; readonly subject: string; readonly credentialCommitted: boolean }
  | {
      readonly type: 'consent';
      readonly decisions: ConsentDecisions;
      readonly personId: string;
      readonly patientId: string;
    }
  | { readonly type: 'claim-result'; readonly result: 'succeeded' | 'refused' | 'unknown' }
  | { readonly type: 'cancel'; readonly reason: CancelReason }
  /** After a cancel during claiming: did the claim win, or is the reservation now released? */
  | { readonly type: 'cancel-resolved'; readonly result: 'claimed' | 'released' }
  | { readonly type: 'activation-step-done'; readonly step: 1 | 2 | 3 }
  | { readonly type: 'cleanup-done' };

export type RefusalReason =
  | 'wrong-state'
  | 'expired'
  | 'subject-mismatch'
  | 'credential-pending'
  | 'incomplete-consent'
  | 'out-of-order';

export type TransitionResult =
  | { readonly ok: true; readonly changed: boolean; readonly tx: EnrolmentTransaction }
  | { readonly ok: false; readonly reason: RefusalReason };

const earliest = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);
const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

export function startTransaction(i: {
  id: string;
  invitationId: string;
  orgId: string;
  now: Date;
}): EnrolmentTransaction {
  const expiresAt = after(i.now, ABSOLUTE_LIFETIME_MS);
  return {
    id: i.id,
    invitationId: i.invitationId,
    orgId: i.orgId,
    status: 'awaiting-confirmation',
    startedAt: i.now,
    expiresAt,
    stateDeadline: earliest(after(i.now, STATE_LIFETIME_MS['awaiting-confirmation']), expiresAt),
    provisionalSubject: null,
    decisions: null,
    personId: null,
    patientId: null,
    cancelRequested: null,
    cancelReason: null,
    activationStep: 0,
  };
}

/** True when a pre-claim transaction has passed its deadline and must be cancelled. */
export function isOverdue(tx: EnrolmentTransaction, now: Date): boolean {
  return (
    PRE_CLAIM.has(tx.status) &&
    tx.stateDeadline !== null &&
    now.getTime() >= tx.stateDeadline.getTime()
  );
}

export function transition(
  tx: EnrolmentTransaction,
  event: EnrolmentEvent,
  now: Date,
): TransitionResult {
  if (event.type === 'cancel') return cancel(tx, event.reason);
  // Past its deadline, a pre-claim transaction can only be cancelled.
  if (isOverdue(tx, now)) return refuse('expired');

  const move = (
    status: EnrolmentStatus,
    fields: Partial<EnrolmentTransaction> = {},
  ): TransitionResult => ({ ok: true, changed: true, tx: { ...tx, ...fields, status } });
  const deadline = (lifetimeMs: number) => earliest(after(now, lifetimeMs), tx.expiresAt);

  switch (event.type) {
    case 'confirm':
      return tx.status === 'awaiting-confirmation'
        ? move('confirmed', { stateDeadline: deadline(STATE_LIFETIME_MS.confirmed) })
        : refuse('wrong-state');

    case 'redeem':
      return tx.status === 'confirmed'
        ? move('redeemed', {
            stateDeadline: deadline(STATE_LIFETIME_MS.redeemed),
            provisionalSubject: event.provisionalSubject,
          })
        : refuse('wrong-state');

    case 'credential-committed':
      if (tx.status === 'redeemed')
        return move('credential-committed', {
          stateDeadline: deadline(STATE_LIFETIME_MS['credential-committed']),
        });
      // The callback may already have reconciled it; a late notice changes nothing.
      return tx.status === 'credential-committed' || tx.status === 'consent-pending'
        ? unchanged(tx)
        : refuse('wrong-state');

    case 'callback':
      if (tx.status !== 'redeemed' && tx.status !== 'credential-committed')
        return refuse('wrong-state');
      if (tx.provisionalSubject === null || event.subject !== tx.provisionalSubject)
        return refuse('subject-mismatch');
      if (tx.status === 'credential-committed') return move('consent-pending');
      // The callback beat the commit notice: proceed only if reconciliation found the credential.
      return event.credentialCommitted
        ? move('consent-pending', {
            stateDeadline: deadline(STATE_LIFETIME_MS['credential-committed']),
          })
        : refuse('credential-pending');

    case 'consent':
      if (tx.status !== 'consent-pending') return refuse('wrong-state');
      // Declining self-tracking ends enrolment at once, whatever else she has answered.
      if (declinesSelfTracking(event.decisions, now)) return cancel(tx, 'declined');
      // Going on needs all four decisions, each with its version and time (section 10).
      if (!completeDecisions(event.decisions, now)) return refuse('incomplete-consent');
      return move('claiming', {
        stateDeadline: null,
        decisions: event.decisions,
        personId: event.personId,
        patientId: event.patientId,
      });

    case 'claim-result':
      if (tx.status !== 'claiming') return refuse('wrong-state');
      if (event.result === 'unknown') return unchanged(tx);
      if (event.result === 'succeeded') return move('activating', { cancelRequested: null });
      return move('cancelling', {
        cancelReason: tx.cancelRequested ?? 'claim-refused',
        cancelRequested: null,
      });

    case 'cancel-resolved':
      if (tx.status !== 'claiming' || tx.cancelRequested === null) return refuse('wrong-state');
      return event.result === 'claimed'
        ? move('activating', { cancelRequested: null })
        : move('cancelling', { cancelReason: tx.cancelRequested, cancelRequested: null });

    case 'activation-step-done':
      if (tx.status === 'active') return unchanged(tx);
      if (tx.status !== 'activating') return refuse('wrong-state');
      if (event.step <= tx.activationStep) return unchanged(tx);
      if (event.step !== tx.activationStep + 1) return refuse('out-of-order');
      return event.step === 3
        ? move('active', { activationStep: 3 })
        : move('activating', { activationStep: event.step });

    case 'cleanup-done':
      if (tx.status === 'cancelled') return unchanged(tx);
      return tx.status === 'cancelling' ? move('cancelled') : refuse('wrong-state');
  }
}

function cancel(tx: EnrolmentTransaction, reason: CancelReason): TransitionResult {
  if (PRE_CLAIM.has(tx.status))
    return {
      ok: true,
      changed: true,
      tx: { ...tx, status: 'cancelling', stateDeadline: null, cancelReason: reason },
    };
  // During claiming the clinical store decides: the coordinator releases the reservation, and
  // the claim either already won (activation) or can no longer win (cleanup).
  if (tx.status === 'claiming')
    return tx.cancelRequested === null
      ? { ok: true, changed: true, tx: { ...tx, cancelRequested: reason } }
      : unchanged(tx);
  if (tx.status === 'cancelling' || tx.status === 'cancelled') return unchanged(tx);
  // activating and active only move forward; leaving is account deletion (REQ-009).
  return refuse('wrong-state');
}

/**
 * Exactly the four purposes, each well-formed and decided no later than now. Checked as untrusted
 * input: the decisions come from her browser through the BFF.
 */
function completeDecisions(d: unknown, now: Date): boolean {
  if (typeof d !== 'object' || d === null) return false;
  const entries = new Map<string, unknown>(Object.entries(d));
  return (
    entries.size === CONSENT_PURPOSES.length &&
    CONSENT_PURPOSES.every((purpose) => validChoice(entries.get(purpose), now))
  );
}

function declinesSelfTracking(d: unknown, now: Date): boolean {
  if (typeof d !== 'object' || d === null) return false;
  const c: unknown = new Map<string, unknown>(Object.entries(d)).get('self_tracking');
  return validChoice(c, now) && (c as ConsentChoice).status === 'declined';
}

function validChoice(c: unknown, now: Date): boolean {
  if (typeof c !== 'object' || c === null) return false;
  const { status, version, decidedAt } = c as Record<string, unknown>;
  return (
    (status === 'granted' || status === 'declined') &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version >= 1 &&
    decidedAt instanceof Date &&
    decidedAt.getTime() <= now.getTime()
  );
}

const unchanged = (tx: EnrolmentTransaction): TransitionResult => ({
  ok: true,
  changed: false,
  tx,
});
const refuse = (reason: RefusalReason): TransitionResult => ({ ok: false, reason });
