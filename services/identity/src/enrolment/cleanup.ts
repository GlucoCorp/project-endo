import type { ClinicalClient } from './clinical.ts';
import type { EnrolmentTransaction } from './state-machine.ts';
import type { OutboxEvent, PostgresEnrolmentStore } from './store.ts';

/** Keycloak's side of cleanup (ADR-0021 section 11): the extension's narrow endpoint. */
export interface KeycloakCleanup {
  /** Deletes the user only while quarantined for this transaction. True once it is gone. */
  deleteProvisional(subject: string, transactionId: string): Promise<boolean>;
}

/** Why a run stopped: done, nothing to do, or waiting for something that will be retried. */
export type CleanupOutcome = 'cancelled' | 'activating' | 'waiting' | 'nothing';

/**
 * Cancellation and cleanup (ADR-0021 sections 10 and 11), run by a sweep:
 *
 * - **Deadlines:** a pre-claim transaction past its deadline is cancelled (the state machine
 *   judges the deadline again under the row lock).
 * - **Cancel during claiming:** the clinical store decides. Releasing the reservation serialises
 *   with the claim on the invitation row: if the claim already won, activation goes on;
 *   otherwise no claim can win any more and the transaction is cancelled.
 * - **Cleanup in `cancelling`:** delete the provisional Keycloak user (only while quarantined for
 *   this transaction), revoke the invitation if she declined, then release it (fenced, so a late
 *   reserve can never succeed). Only then `cancelled`. Every step is idempotent; a failing step
 *   is retried by the next sweep, never skipped.
 *
 * Nothing secret is left to wipe: the code's MAC is cleared when confirmation ends, the browser
 * secret and handoff references are stored only as hashes, and handoffs expire in five minutes.
 */
export class Cleaner {
  readonly #store: PostgresEnrolmentStore;
  readonly #clinical: ClinicalClient;
  readonly #keycloak: KeycloakCleanup | null;
  readonly #now: () => Date;
  readonly #audit: (action: string, tx: EnrolmentTransaction) => OutboxEvent;

  constructor(opts: {
    store: PostgresEnrolmentStore;
    clinical: ClinicalClient;
    keycloak: KeycloakCleanup | null;
    now: () => Date;
    audit: (action: string, tx: EnrolmentTransaction) => OutboxEvent;
  }) {
    this.#store = opts.store;
    this.#clinical = opts.clinical;
    this.#keycloak = opts.keycloak;
    this.#now = opts.now;
    this.#audit = opts.audit;
  }

  /** One pass: cancel what is overdue, then clean up. Returns how many are still waiting. */
  async sweep(): Promise<number> {
    for (const id of await this.#store.listOverdue(this.#now())) {
      try {
        await this.#store.apply(id, { type: 'cancel', reason: 'deadline' }, this.#now, (_, after) =>
          this.#audit('identity.enrolment.expired', after),
        );
      } catch {
        // Retried on the next sweep.
      }
    }
    let waiting = 0;
    for (const id of await this.#store.listCleanup()) {
      try {
        if ((await this.run(id)) === 'waiting') waiting++;
      } catch {
        waiting++;
      }
    }
    return waiting;
  }

  async run(id: string): Promise<CleanupOutcome> {
    const tx = (await this.#store.get(id))?.tx;
    if (!tx) return 'nothing';
    if (tx.status === 'claiming' && tx.cancelRequested !== null) return this.#resolve(tx);
    if (tx.status === 'cancelling') return this.#cleanup(tx);
    return tx.status === 'cancelled' ? 'cancelled' : 'nothing';
  }

  async #resolve(tx: EnrolmentTransaction): Promise<CleanupOutcome> {
    let result: 'released' | 'claimed';
    try {
      result = await this.#clinical.release(reservation(tx));
    } catch {
      return 'waiting'; // Unknown: ask again on the next sweep.
    }
    const r = await this.#store.apply(
      tx.id,
      { type: 'cancel-resolved', result },
      this.#now,
      (_, after) =>
        this.#audit(
          result === 'claimed' ? 'identity.enrolment.claimed' : 'identity.enrolment.cancelled',
          after,
        ),
    );
    if (!r.ok) return 'waiting';
    if (result === 'claimed') return 'activating';
    return this.#cleanup(r.tx);
  }

  async #cleanup(tx: EnrolmentTransaction): Promise<CleanupOutcome> {
    try {
      if (tx.provisionalSubject !== null) {
        if (!this.#keycloak) return 'waiting';
        if (!(await this.#keycloak.deleteProvisional(tx.provisionalSubject, tx.id)))
          return 'waiting';
      }
      // Revoked first: releasing before it would let another enrolment take the invitation.
      if (tx.cancelReason === 'declined') await this.#clinical.revokeHeld(reservation(tx));
      // `claimed` here would mean a claim won after cancelling, which the clinical store's
      // ordering rules out; cleanup never finishes over it.
      if ((await this.#clinical.release(reservation(tx))) !== 'released') return 'waiting';
    } catch {
      return 'waiting';
    }
    const r = await this.#store.apply(tx.id, { type: 'cleanup-done' }, this.#now, (_, after) =>
      this.#audit('identity.enrolment.cleaned_up', after),
    );
    return r.ok ? 'cancelled' : 'waiting';
  }
}

function reservation(tx: EnrolmentTransaction) {
  return { orgId: tx.orgId, invitationId: tx.invitationId, transactionId: tx.id };
}
