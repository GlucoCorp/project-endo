import { CONSENT_PURPOSES } from '@endo/authz';
import type { ClinicalClient } from './clinical.ts';
import type { EnrolmentTransaction } from './state-machine.ts';
import type { OutboxEvent, PostgresEnrolmentStore } from './store.ts';

/** Keycloak's side of activation (ADR-0021 section 10, step 3): the extension's endpoint. */
export interface KeycloakFinaliser {
  /** Assigns `patient` and lifts the quarantine. True once Keycloak has durably done it. */
  finalise(subject: string, transactionId: string): Promise<boolean>;
}

/** Why a run stopped: done, nothing to do, or waiting for something that will be retried. */
export type ActivationOutcome = 'active' | 'cancelling' | 'waiting' | 'nothing';

/**
 * Activation (ADR-0021 section 10): from `claiming` to `active`, one durable step at a time.
 *
 * 1. Claim in the clinical store (creates the patient record). A definite refusal cancels; an
 *    unknown outcome is left for the next run, which asks again (claiming is idempotent).
 * 2. Identity: the person and the patient link (one identity transaction with the step).
 * 3. Clinical: her four consent decisions with their versions and the times she chose.
 * 4. Keycloak: `patient` assigned, quarantine lifted. Without a finaliser it waits there, so she
 *    stays quarantined: safe, never half-active.
 *
 * Each step is recorded before the next; a failed step is retried by the next run (the sweep
 * runs every 30 seconds), never skipped. A cancellation requested during claiming is resolved by
 * the cleanup slice; this worker leaves such a transaction alone.
 */
export class Activator {
  readonly #store: PostgresEnrolmentStore;
  readonly #clinical: ClinicalClient;
  readonly #keycloak: KeycloakFinaliser | null;
  readonly #now: () => Date;
  readonly #audit: (action: string, tx: EnrolmentTransaction) => OutboxEvent;

  constructor(opts: {
    store: PostgresEnrolmentStore;
    clinical: ClinicalClient;
    keycloak: KeycloakFinaliser | null;
    now: () => Date;
    audit: (action: string, tx: EnrolmentTransaction) => OutboxEvent;
  }) {
    this.#store = opts.store;
    this.#clinical = opts.clinical;
    this.#keycloak = opts.keycloak;
    this.#now = opts.now;
    this.#audit = opts.audit;
  }

  async run(id: string): Promise<ActivationOutcome> {
    // At most one pass per step: a step either moves on or stops this run.
    for (let i = 0; i < 5; i++) {
      const tx = (await this.#store.get(id))?.tx;
      if (!tx) return 'nothing';
      if (tx.status === 'active') return 'active';
      if (tx.status === 'cancelling' || tx.status === 'cancelled') return 'cancelling';
      if (tx.status === 'claiming') {
        if (tx.cancelRequested !== null) return 'waiting';
        if (!(await this.#claim(tx))) return 'waiting';
        continue;
      }
      if (tx.status !== 'activating') return 'nothing';
      const next = await this.#step(tx);
      if (!next) return 'waiting';
    }
    return 'waiting';
  }

  /** Every transaction with activation work left (the periodic sweep). */
  async sweep(): Promise<void> {
    for (const id of await this.#store.listActivating()) {
      try {
        await this.run(id);
      } catch {
        // One failing transaction never stops the others; it is retried on the next sweep.
      }
    }
  }

  async #claim(tx: EnrolmentTransaction): Promise<boolean> {
    if (tx.personId === null || tx.patientId === null) return false;
    let result: 'done' | 'refused';
    try {
      result = await this.#clinical.claim({
        orgId: tx.orgId,
        invitationId: tx.invitationId,
        transactionId: tx.id,
        patientId: tx.patientId,
        identityRef: tx.personId,
      });
    } catch {
      return false; // Unknown: ask again next run.
    }
    const r = await this.#store.apply(
      tx.id,
      { type: 'claim-result', result: result === 'done' ? 'succeeded' : 'refused' },
      this.#now,
      (_, after) =>
        this.#audit(
          after.status === 'activating'
            ? 'identity.enrolment.claimed'
            : 'identity.enrolment.cancelled',
          after,
        ),
    );
    return r.ok;
  }

  async #step(tx: EnrolmentTransaction): Promise<boolean> {
    const done = (step: 1 | 2 | 3, action: string) =>
      this.#store.apply(tx.id, { type: 'activation-step-done', step }, this.#now, (_, after) =>
        this.#audit(action, after),
      );
    try {
      if (tx.activationStep === 0) {
        const r = await this.#store.activatePerson(tx.id, this.#now, (_, after) =>
          this.#audit('identity.enrolment.person_created', after),
        );
        return r.ok;
      }
      if (tx.activationStep === 1) {
        if (tx.decisions === null || tx.patientId === null) return false;
        const decisions = tx.decisions;
        await this.#clinical.consents({
          orgId: tx.orgId,
          patientId: tx.patientId,
          decisions: CONSENT_PURPOSES.map((purpose) => {
            const d = new Map(Object.entries(decisions)).get(purpose);
            if (!d) throw new Error('a claimed transaction has all four decisions');
            return { purpose, status: d.status, version: d.version, chosenAt: d.decidedAt };
          }),
        });
        return (await done(2, 'identity.enrolment.consents_recorded')).ok;
      }
      if (tx.activationStep === 2) {
        if (!this.#keycloak || tx.provisionalSubject === null) return false;
        if (!(await this.#keycloak.finalise(tx.provisionalSubject, tx.id))) return false;
        return (await done(3, 'identity.enrolment.active')).ok;
      }
      return false;
    } catch {
      return false; // Retried by the next run.
    }
  }
}
