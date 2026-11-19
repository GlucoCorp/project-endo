import type { WorkloadTokenSigner } from '@endo/service-kit';

/** A clinician's active membership of one organisation (ADR-0019 section 4). */
export interface Membership {
  readonly orgId: string;
  readonly role: 'clinician' | 'org_admin';
}

export interface Resolver {
  /** Keycloak subject -> person id, or null if unknown or erased. */
  person(issuer: string, subject: string): Promise<string | null>;
  /** Person id -> active memberships (organisation and role only). */
  memberships(personId: string): Promise<Membership[]>;
  /** REQ-010: claims a staff invitation (by its token's hash) for this person. */
  claimStaff?(tokenHash: string, personId: string): Promise<'claimed' | 'unavailable'>;
}

export class ResolverError extends Error {
  constructor() {
    super('upstream.unavailable');
    this.name = 'ResolverError';
  }
}

/**
 * Calls the identity service and the API with workload tokens (ADR-0018), one scope per call.
 * Inputs come only from a validated callback and from identity resolution, never from the
 * browser (ADR-0019 section 4).
 */
export class HttpResolver implements Resolver {
  readonly #identityUrl: string;
  readonly #apiUrl: string;
  readonly #signer: WorkloadTokenSigner;
  readonly #fetch: typeof fetch;

  constructor(opts: {
    identityBaseUrl: string;
    apiBaseUrl: string;
    signer: WorkloadTokenSigner;
    fetch: typeof fetch;
  }) {
    this.#identityUrl = opts.identityBaseUrl;
    this.#apiUrl = opts.apiBaseUrl;
    this.#signer = opts.signer;
    this.#fetch = opts.fetch;
  }

  async #post(url: string, scope: string, audience: 'identity' | 'api', body: object) {
    const token = await this.#signer.sign([scope], audience);
    try {
      return await this.#fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ResolverError();
    }
  }

  async person(issuer: string, subject: string): Promise<string | null> {
    const res = await this.#post(
      `${this.#identityUrl}/internal/v1/subjects/resolve`,
      'identity.subject.resolve',
      'identity',
      { idp_issuer: issuer, idp_subject: subject },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new ResolverError();
    const body = (await res.json()) as { person_id?: unknown };
    if (typeof body.person_id !== 'string') throw new ResolverError();
    return body.person_id;
  }

  async claimStaff(tokenHash: string, personId: string): Promise<'claimed' | 'unavailable'> {
    const res = await this.#post(
      `${this.#apiUrl}/internal/v1/staff-invitations/claim`,
      'api.staff.join',
      'api',
      { token_hash: tokenHash, person_id: personId },
    );
    if (res.ok) return 'claimed';
    // A link that cannot be used, or someone already in the organisation: sign-in goes on.
    if (res.status === 404 || res.status === 409) return 'unavailable';
    throw new ResolverError();
  }

  async memberships(personId: string): Promise<Membership[]> {
    const res = await this.#post(
      `${this.#apiUrl}/internal/v1/memberships/resolve`,
      'api.membership.resolve',
      'api',
      { identity_ref: personId },
    );
    if (!res.ok) throw new ResolverError();
    const body = (await res.json()) as { memberships?: unknown };
    if (!Array.isArray(body.memberships)) throw new ResolverError();
    return body.memberships.map((m: unknown) => {
      const v = m as { org_id?: unknown; role?: unknown };
      if (typeof v.org_id !== 'string' || (v.role !== 'clinician' && v.role !== 'org_admin')) {
        throw new ResolverError();
      }
      return { orgId: v.org_id, role: v.role };
    });
  }
}
