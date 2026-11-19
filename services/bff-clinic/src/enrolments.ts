import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProblemError, type ServiceTokenSigner } from '@endo/service-kit';
import type { ClinicSession } from './sessions.ts';

export interface ClinicEnrolmentDeps {
  readonly apiBaseUrl: string;
  /** Service tokens carrying the signed-in clinician (ADR-0019), minted per call. */
  readonly signer: ServiceTokenSigner;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** Code entries per clinician per minute (default 10), on top of the per-invitation lock. */
  readonly confirmsPerMinute?: number;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const SHARING = new Set(['shared', 'declined', 'pending']);

const unavailable = () =>
  new ProblemError(502, 'upstream_unavailable', 'The service is not available right now.');

/** A sliding one-minute window per clinician, in memory (one instance per BFF replica). */
class PerClinicianLimit {
  readonly #max: number;
  readonly #now: () => Date;
  readonly #hits = new Map<string, number[]>();

  constructor(max: number, now: () => Date) {
    this.#max = max;
    this.#now = now;
  }

  take(key: string): boolean {
    const t = this.#now().getTime();
    const recent = (this.#hits.get(key) ?? []).filter((h) => t - h < 60_000);
    if (recent.length >= this.#max) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.#hits.set(key, recent);
    return true;
  }
}

/**
 * Clinic enrolment (ADR-0021 sections 2 and 3): list the organisation's open invitations, and
 * confirm the woman in front of the clinician by the code on her phone. Session routes: the
 * app-level hook has already checked the session, its organisation, and (for the POST) the exact
 * Origin and this session's CSRF token.
 */
export function registerClinicEnrolmentRoutes(
  app: FastifyInstance,
  deps: ClinicEnrolmentDeps,
): void {
  const limit = new PerClinicianLimit(deps.confirmsPerMinute ?? 10, deps.now);

  const callApi = async (
    request: FastifyRequest,
    session: ClinicSession,
    path: string,
    init: { method: 'GET' | 'POST'; body?: object },
  ): Promise<Response> => {
    const active = session.active;
    if (!active)
      throw new ProblemError(403, 'authz.organisation_required', 'Choose an organisation first.');
    const token = await deps.signer.sign(
      { sub: session.personId, role: active.role, org_id: active.orgId, patient_id: null },
      'api',
    );
    try {
      return await deps.fetch(new URL(path, deps.apiBaseUrl), {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': request.id,
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw unavailable();
    }
  };

  const denied = (res: Response) => {
    if (res.status === 401 || res.status === 403)
      throw new ProblemError(403, 'authz.denied', 'You do not have access to this.');
  };

  app.get('/v1/enrolments', { config: { auth: { kind: 'session' } } }, async (request) => {
    const session = request.session;
    if (!session) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    const res = await callApi(request, session, '/v1/enrolments', { method: 'GET' });
    denied(res);
    if (!res.ok) throw unavailable();
    const body = (await res.json().catch(() => null)) as {
      invitations?: unknown;
      accepted?: unknown;
    } | null;
    if (!Array.isArray(body?.invitations) || !Array.isArray(body.accepted)) throw unavailable();
    // Pass on only the fields the portal shows, each checked.
    return {
      invitations: body.invitations.map((i: unknown) => {
        const v = i as Record<string, unknown>;
        if (
          typeof v['id'] !== 'string' ||
          !new RegExp(UUID).test(v['id']) ||
          typeof v['created_at'] !== 'string' ||
          typeof v['expires_at'] !== 'string' ||
          typeof v['in_use'] !== 'boolean'
        )
          throw unavailable();
        return {
          id: v['id'],
          created_at: v['created_at'],
          expires_at: v['expires_at'],
          in_use: v['in_use'],
        };
      }),
      // REQ-001: when, and whether she shares; nothing that says who she is.
      accepted: body.accepted.map((a: unknown) => {
        const v = a as Record<string, unknown>;
        if (
          typeof v['id'] !== 'string' ||
          !new RegExp(UUID).test(v['id']) ||
          typeof v['accepted_at'] !== 'string' ||
          !SHARING.has(v['sharing'] as string)
        )
          throw unavailable();
        return { id: v['id'], accepted_at: v['accepted_at'], sharing: v['sharing'] };
      }),
    };
  });

  app.post(
    '/v1/enrolments/:id/confirm',
    {
      config: { auth: { kind: 'session' } },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'identified', 'own_phone'],
          properties: {
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            identified: { const: true },
            own_phone: { const: true },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
      if (!limit.take(session.personId))
        throw new ProblemError(429, 'rate_limited', 'Too many codes entered. Wait a minute.');
      const { id } = request.params as { id: string };
      const res = await callApi(request, session, `/v1/enrolments/${id}/confirm`, {
        method: 'POST',
        body: request.body as object,
      });
      denied(res);
      if (!res.ok) throw unavailable();
      const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (b?.['outcome'] === 'confirmed' || b?.['outcome'] === 'unavailable')
        return { outcome: b['outcome'] };
      if (b?.['outcome'] === 'wrong' && typeof b['remaining'] === 'number')
        return { outcome: 'wrong', remaining: b['remaining'] };
      if (b?.['outcome'] === 'locked' && typeof b['locked_until'] === 'string')
        return { outcome: 'locked', locked_until: b['locked_until'] };
      throw unavailable();
    },
  );
}
