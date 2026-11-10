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
}
