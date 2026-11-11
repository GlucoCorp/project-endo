import type { WorkloadTokenSigner } from '@endo/service-kit';

/** What the clinic attests when confirming (ADR-0021 section 2). Both must be true. */
export interface Attestation {
  /** She was identified the way the clinic normally does. */
  readonly identified: true;
  /** The code was read from her own phone. */
  readonly ownPhone: true;
}

export interface ConfirmRequest {
  readonly orgId: string;
  readonly invitationId: string;
  readonly code: string;
  /** The clinician's id in the clinical store (opaque), for the audit trail. */
  readonly clinicianId: string;
  readonly attestation: Attestation;
  readonly requestId: string;
}

export type ConfirmOutcome =
  | { readonly outcome: 'confirmed' }
  | { readonly outcome: 'wrong'; readonly remaining: number }
  | { readonly outcome: 'locked'; readonly lockedUntil: string }
  /** The code matched, but the invitation could no longer be reserved (revoked, expired, taken). */
  | { readonly outcome: 'unavailable' };

/** The identity service's clinic-side enrolment route (ADR-0021 section 13). */
export interface IdentityEnrolment {
  confirm(r: ConfirmRequest): Promise<ConfirmOutcome>;
}

export class IdentityUnavailableError extends Error {
  constructor() {
    super('upstream.unavailable');
    this.name = 'IdentityUnavailableError';
  }
}

/**
 * Calls the identity service with a workload token holding only `identity.enrolment.clinic`
 * (ADR-0018). No redirects, a 5-second timeout; any unexpected answer is an error.
 */
export class HttpIdentityEnrolment implements IdentityEnrolment {
  readonly #url: string;
  readonly #signer: WorkloadTokenSigner;
  readonly #fetch: typeof fetch;

  constructor(opts: { identityBaseUrl: string; signer: WorkloadTokenSigner; fetch: typeof fetch }) {
    this.#url = opts.identityBaseUrl;
    this.#signer = opts.signer;
    this.#fetch = opts.fetch;
  }

  async confirm(r: ConfirmRequest): Promise<ConfirmOutcome> {
    const token = await this.#signer.sign(['identity.enrolment.clinic'], 'identity');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}/internal/v1/enrolment/confirm`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': r.requestId,
        },
        body: JSON.stringify({
          org_id: r.orgId,
          invitation_id: r.invitationId,
          code: r.code,
          clinician_id: r.clinicianId,
          attestation: { identified: true, own_phone: true },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new IdentityUnavailableError();
    }
    if (!res.ok) throw new IdentityUnavailableError();
    const b = (await res.json().catch(() => null)) as {
      outcome?: unknown;
      remaining?: unknown;
      locked_until?: unknown;
    } | null;
    if (b?.outcome === 'confirmed' || b?.outcome === 'unavailable') return { outcome: b.outcome };
    if (b?.outcome === 'wrong' && typeof b.remaining === 'number')
      return { outcome: 'wrong', remaining: b.remaining };
    if (b?.outcome === 'locked' && typeof b.locked_until === 'string')
      return { outcome: 'locked', lockedUntil: b.locked_until };
    throw new IdentityUnavailableError();
  }
}
