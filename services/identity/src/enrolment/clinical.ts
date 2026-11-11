import type { WorkloadTokenSigner } from '@endo/service-kit';

/** A live invitation as the clinical store reports it (ADR-0021 section 6). */
export interface LiveInvitation {
  readonly invitationId: string;
  readonly orgId: string;
  /** An enrolment transaction holds it; new starts are refused. */
  readonly reserved: boolean;
}

/** What the coordinator reads from the API (ADR-0021 section 13). */
export interface ClinicalClient {
  /** The live invitation for a link token's SHA-256, or null when the link is not live. */
  find(tokenHash: string): Promise<LiveInvitation | null>;
  /**
   * Holds the invitation for this transaction (ADR-0021 section 6). `done` also when this
   * transaction already holds it; `refused` when it is revoked, expired, claimed or held by another.
   */
  reserve(r: {
    orgId: string;
    invitationId: string;
    transactionId: string;
  }): Promise<'done' | 'refused'>;
  /**
   * Creates the patient record and claims the invitation (ADR-0021 section 10). `refused` is
   * definite (revoked, expired, not reserved by this transaction); an error means unknown.
   */
  claim(r: ClaimInput): Promise<'done' | 'refused'>;
  /** Writes her four enrolment decisions (activation step 2); resolves once they are stored. */
  consents(r: ConsentsInput): Promise<void>;
  /**
   * Ends this transaction's hold for good, fenced (ADR-0021 sections 6 and 11). `released` also
   * when there was nothing to release; `claimed` when its claim already won, so activation goes on.
   */
  release(r: ReservationInput): Promise<'released' | 'claimed'>;
  /** After she declined: revokes the invitation while this transaction holds it (section 11). */
  revokeHeld(r: ReservationInput): Promise<'done' | 'refused'>;
}

export interface ReservationInput {
  readonly orgId: string;
  readonly invitationId: string;
  readonly transactionId: string;
}

export interface ClaimInput {
  readonly orgId: string;
  readonly invitationId: string;
  readonly transactionId: string;
  readonly patientId: string;
  readonly identityRef: string;
}

export interface ConsentsInput {
  readonly orgId: string;
  readonly patientId: string;
  readonly decisions: readonly {
    readonly purpose: string;
    readonly status: 'granted' | 'declined';
    readonly version: number;
    readonly chosenAt: Date;
  }[];
}

/** The API could not be reached or answered something unexpected. Callers fail closed. */
export class ClinicalUnavailableError extends Error {
  constructor() {
    super('upstream.unavailable');
    this.name = 'ClinicalUnavailableError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Calls the API's coordinator routes with a workload token holding only
 * `api.enrolment.coordinate` (ADR-0018). No redirects, a 5-second timeout, and every answer is
 * checked before use: anything unexpected is an error, never a guess.
 */
export class HttpClinicalClient implements ClinicalClient {
  readonly #apiUrl: string;
  readonly #signer: WorkloadTokenSigner;
  readonly #fetch: typeof fetch;

  constructor(opts: { apiBaseUrl: string; signer: WorkloadTokenSigner; fetch: typeof fetch }) {
    this.#apiUrl = opts.apiBaseUrl;
    this.#signer = opts.signer;
    this.#fetch = opts.fetch;
  }

  async find(tokenHash: string): Promise<LiveInvitation | null> {
    const token = await this.#signer.sign(['api.enrolment.coordinate'], 'api');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiUrl}/internal/v1/enrolment/invitations/find`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ token_hash: tokenHash }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ClinicalUnavailableError();
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ClinicalUnavailableError();
    const body = (await res.json().catch(() => null)) as {
      invitation_id?: unknown;
      org_id?: unknown;
      reserved?: unknown;
    } | null;
    if (
      !body ||
      typeof body.invitation_id !== 'string' ||
      !UUID.test(body.invitation_id) ||
      typeof body.org_id !== 'string' ||
      !UUID.test(body.org_id) ||
      typeof body.reserved !== 'boolean'
    )
      throw new ClinicalUnavailableError();
    return { invitationId: body.invitation_id, orgId: body.org_id, reserved: body.reserved };
  }

  async reserve(r: {
    orgId: string;
    invitationId: string;
    transactionId: string;
  }): Promise<'done' | 'refused'> {
    const token = await this.#signer.sign(['api.enrolment.coordinate'], 'api');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiUrl}/internal/v1/enrolment/invitations/reserve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          org_id: r.orgId,
          invitation_id: r.invitationId,
          transaction_id: r.transactionId,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ClinicalUnavailableError();
    }
    if (!res.ok) throw new ClinicalUnavailableError();
    const body = (await res.json().catch(() => null)) as { outcome?: unknown } | null;
    if (body?.outcome === 'done' || body?.outcome === 'refused') return body.outcome;
    throw new ClinicalUnavailableError();
  }

  async #post(path: string, body: object): Promise<Response> {
    const token = await this.#signer.sign(['api.enrolment.coordinate'], 'api');
    try {
      return await this.#fetch(`${this.#apiUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ClinicalUnavailableError();
    }
  }

  async claim(r: ClaimInput): Promise<'done' | 'refused'> {
    const res = await this.#post('/internal/v1/enrolment/invitations/claim', {
      org_id: r.orgId,
      invitation_id: r.invitationId,
      transaction_id: r.transactionId,
      patient_id: r.patientId,
      identity_ref: r.identityRef,
    });
    if (!res.ok) throw new ClinicalUnavailableError();
    const body = (await res.json().catch(() => null)) as { outcome?: unknown } | null;
    if (body?.outcome === 'done' || body?.outcome === 'refused') return body.outcome;
    throw new ClinicalUnavailableError();
  }

  async release(r: ReservationInput): Promise<'released' | 'claimed'> {
    const body = await this.#reservation('release', r);
    if (body.outcome === 'done' || body.status === 'missing') return 'released';
    if (body.status === 'claimed' && body.reservedBy === r.transactionId) return 'claimed';
    // Release refuses nothing else; anything more is unexpected, so unknown.
    throw new ClinicalUnavailableError();
  }

  async revokeHeld(r: ReservationInput): Promise<'done' | 'refused'> {
    return (await this.#reservation('revoke', r)).outcome;
  }

  async #reservation(
    op: 'release' | 'revoke',
    r: ReservationInput,
  ): Promise<{ outcome: 'done' | 'refused'; status: string; reservedBy: unknown }> {
    const res = await this.#post(`/internal/v1/enrolment/invitations/${op}`, {
      org_id: r.orgId,
      invitation_id: r.invitationId,
      transaction_id: r.transactionId,
    });
    if (!res.ok) throw new ClinicalUnavailableError();
    const body = (await res.json().catch(() => null)) as {
      outcome?: unknown;
      state?: { status?: unknown; reserved_by?: unknown };
    } | null;
    const outcome = body?.outcome;
    const status = body?.state?.status;
    if ((outcome !== 'done' && outcome !== 'refused') || typeof status !== 'string')
      throw new ClinicalUnavailableError();
    return { outcome, status, reservedBy: body?.state?.reserved_by };
  }

  async consents(r: ConsentsInput): Promise<void> {
    const res = await this.#post('/internal/v1/enrolment/consents', {
      org_id: r.orgId,
      patient_id: r.patientId,
      decisions: r.decisions.map((d) => ({
        purpose: d.purpose,
        status: d.status,
        version: d.version,
        chosen_at: d.chosenAt.toISOString(),
      })),
    });
    if (!res.ok) throw new ClinicalUnavailableError();
  }
}
