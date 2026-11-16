import type { WorkloadTokenSigner } from '@endo/service-kit';
import type { Client } from './smart.ts';

/** What the integration service asks the API (spec 8.2: record system <- integration -> api). */
export interface ApiPort {
  /** The client, or null if unknown. Throws if the API cannot be reached (fail closed). */
  resolveClient(clientId: string): Promise<Client | null>;
  /** True the first time this assertion id is used, across instances (replay protection). */
  reserveAssertion(clientId: string, jti: string, expiresAt: Date): Promise<boolean>;
  /** Her resources as a FHIR Bundle, or null if not shared with this organisation's care team. */
  patient(
    orgId: string,
    patientId: string,
    clientId: string,
  ): Promise<Record<string, unknown> | null>;
}

export class ApiUnavailableError extends Error {
  constructor() {
    super('upstream.unavailable');
    this.name = 'ApiUnavailableError';
  }
}

/**
 * Calls the API with the integration service's workload key, one scope per call
 * (`api.integration.resolve`, `api.fhir.read`). No redirects, a 5-second timeout.
 */
export class HttpApi implements ApiPort {
  readonly #url: string;
  readonly #signer: WorkloadTokenSigner;
  readonly #fetch: typeof fetch;

  constructor(opts: { apiBaseUrl: string; signer: WorkloadTokenSigner; fetch: typeof fetch }) {
    this.#url = opts.apiBaseUrl;
    this.#signer = opts.signer;
    this.#fetch = opts.fetch;
  }

  async #post(path: string, scope: string, body: object, requestId?: string): Promise<Response> {
    const token = await this.#signer.sign([scope], 'api');
    try {
      return await this.#fetch(new URL(path, this.#url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ApiUnavailableError();
    }
  }

  async resolveClient(clientId: string): Promise<Client | null> {
    const res = await this.#post(
      '/internal/v1/integration/clients/resolve',
      'api.integration.resolve',
      {
        client_id: clientId,
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiUnavailableError();
    const b = (await res.json()) as {
      id: string;
      org_id: string;
      jwks: Client['jwks'];
      scopes: string[];
      active: boolean;
    };
    return { id: b.id, orgId: b.org_id, jwks: b.jwks, scopes: b.scopes, active: b.active };
  }

  async reserveAssertion(clientId: string, jti: string, expiresAt: Date): Promise<boolean> {
    const res = await this.#post(
      '/internal/v1/integration/assertions/reserve',
      'api.integration.resolve',
      { client_id: clientId, jti, expires_at: expiresAt.toISOString() },
    );
    if (!res.ok) throw new ApiUnavailableError();
    const b = (await res.json()) as { first_use?: unknown };
    return b.first_use === true;
  }

  async patient(orgId: string, patientId: string, clientId: string) {
    const res = await this.#post('/internal/v1/fhir/patient', 'api.fhir.read', {
      org_id: orgId,
      patient_id: patientId,
      client_id: clientId,
    });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new ApiUnavailableError();
    return (await res.json()) as Record<string, unknown>;
  }
}
