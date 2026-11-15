import type { DeletionStore } from '@endo/clinical-store';
import type { WorkloadTokenSigner } from '@endo/service-kit';

/**
 * The identity service's erasure route. It crypto-shreds her identity key and clears her sign-in
 * subject at once (her name and email are unreadable; she can no longer be resolved). Removing
 * the identity rows and her Keycloak account is a later step (Section 24 item 38).
 */
export interface IdentityErasure {
  /** True once her identity record is erased (or was already gone). */
  erase(personId: string, requestId: string): Promise<boolean>;
}

/**
 * Calls `/internal/v1/persons/:id/erasure` with a workload token from the jobs key holding only
 * `identity.person.erase` (the identity service trusts no other caller for it). No redirects, a
 * 5-second timeout. 404 means she is already gone, which counts as done.
 */
export class HttpIdentityErasure implements IdentityErasure {
  readonly #url: string;
  readonly #signer: WorkloadTokenSigner;
  readonly #fetch: typeof fetch;

  constructor(opts: { identityBaseUrl: string; signer: WorkloadTokenSigner; fetch: typeof fetch }) {
    this.#url = opts.identityBaseUrl;
    this.#signer = opts.signer;
    this.#fetch = opts.fetch;
  }

  async erase(personId: string, requestId: string): Promise<boolean> {
    const token = await this.#signer.sign(['identity.person.erase'], 'identity');
    try {
      const res = await this.#fetch(
        `${this.#url}/internal/v1/persons/${encodeURIComponent(personId)}/erasure`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-request-id': requestId },
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        },
      );
      return res.status === 204 || res.status === 404;
    } catch {
      return false;
    }
  }
}

export interface DeletionRun {
  readonly erased: number;
  readonly identityErased: number;
  readonly failed: number;
}

/**
 * REQ-009, spec 11.4: hourly, for each request whose 14 days are over, erase her clinical data
 * (her key first, then every row, in one transaction: `patient_erase`), then her identity record.
 * The identity step is retried every run until it succeeds. The audit events name the opaque
 * patient id only; they stay (spec 11.4: audit events are kept, without PHI). Counts only are
 * returned; nothing about her is logged.
 */
export class DeletionJob {
  readonly #store: DeletionStore;
  readonly #identity: IdentityErasure;
  readonly #newId: () => string;

  constructor(store: DeletionStore, identity: IdentityErasure, newId: () => string) {
    this.#store = store;
    this.#identity = identity;
    this.#newId = newId;
  }

  async run(): Promise<DeletionRun> {
    let erased = 0;
    let identityErased = 0;
    let failed = 0;
    for (const d of await this.#store.due()) {
      try {
        const requestId = this.#newId();
        const done = await this.#store.erase(d.orgId, d.patientId, {
          id: this.#newId(),
          actor: { id: null, role: 'system' },
          action: 'patient.erased',
          resource: { type: 'patient_record', id: d.patientId },
          org_id: d.orgId,
          purpose_of_use: 'operations',
          outcome: 'success',
          reason: null,
          request_id: requestId,
        });
        if (done) erased += 1;
      } catch {
        failed += 1;
      }
    }
    for (const p of await this.#store.identityPending()) {
      try {
        if (await this.#identity.erase(p.identityRef, this.#newId())) {
          await this.#store.markIdentityErased(p.orgId, p.id);
          identityErased += 1;
        } else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { erased, identityErased, failed };
  }
}
