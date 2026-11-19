import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, type ServiceTokenSigner } from '@endo/service-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ClinicEpisodeDeps {
  readonly apiBaseUrl: string;
  readonly signer: ServiceTokenSigner;
  readonly fetch: typeof fetch;
}

/**
 * Drafting treatment episodes from the clinic portal (REQ-002), passed to the API as the signed-in
 * clinician of the chosen organisation (ADR-0019). Session routes: the app-level hook has checked
 * the session, its organisation and, for the POST, the exact Origin and the CSRF token. The API
 * decides consent and organisation; only its code comes back on a refusal.
 */
export function registerClinicEpisodeRoutes(app: FastifyInstance, deps: ClinicEpisodeDeps): void {
  const pass = async (
    request: FastifyRequest,
    reply: FastifyReply,
    method: 'GET' | 'POST',
    path: string,
  ) => {
    const session = request.session;
    const active = session?.active;
    if (!session || !active)
      throw new ProblemError(403, 'authz.organisation_required', 'Choose an organisation first.');
    const key = request.headers['idempotency-key'];
    if (method === 'POST' && (typeof key !== 'string' || !UUID.test(key)))
      throw new ProblemError(400, 'request.idempotency_key_required', 'Request refused.');
    const token = await deps.signer.sign(
      { sub: session.personId, role: active.role, org_id: active.orgId, patient_id: null },
      'api',
    );
    let res: Response;
    try {
      res = await deps.fetch(new URL(path, deps.apiBaseUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': request.id,
          accept: 'application/json',
          ...(method === 'POST'
            ? { 'content-type': 'application/json', 'idempotency-key': key as string }
            : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ProblemError(
        502,
        'upstream_unavailable',
        'The service is not available right now.',
      );
    }
    if (res.status === 204) return reply.code(204).send();
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body) return reply.code(res.status).send(body);
    if (res.status === 401 || res.status === 403)
      throw new ProblemError(403, 'authz.denied', 'You do not have access to this.');
    if ([400, 404, 409, 422].includes(res.status)) {
      const type = typeof body?.['type'] === 'string' ? body['type'] : '';
      const code = /([a-z_]+\.[a-z_.]+)$/.exec(type)?.[1] ?? 'request.refused';
      throw new ProblemError(res.status, code, 'This could not be saved.');
    }
    throw new ProblemError(502, 'upstream_error', 'The service is not available right now.');
  };
  const patient = (request: FastifyRequest) => {
    const id = (request.params as { patientId?: string }).patientId ?? '';
    if (!UUID.test(id)) throw new ProblemError(404, 'patient.not_found', 'Not found.');
    return id;
  };
  const session = { auth: { kind: 'session' } } as const;

  app.get('/v1/catalogue', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/catalogue'),
  );
  app.get('/v1/patients', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/patients'),
  );
  app.get('/v1/patients/:patientId/episodes', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', `/v1/patients/${patient(request)}/episodes`),
  );
  app.post(
    '/v1/patients/:patientId/episodes',
    { config: session, bodyLimit: 4096, schema: { body: { type: 'object' } } },
    (request, reply) => pass(request, reply, 'POST', `/v1/patients/${patient(request)}/episodes`),
  );

  // M4 clinician desk (REQ-005, REQ-006): the queue, the review, the decision, the pre-surgery
  // check. Same checks: session, organisation, Origin and CSRF (hook); ids checked as UUIDs.
  const episode = (request: FastifyRequest) => {
    const id = (request.params as { id?: string }).id ?? '';
    if (!UUID.test(id)) throw new ProblemError(404, 'episode.not_found', 'Not found.');
    return id;
  };
  app.get('/v1/reviews/queue', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/reviews/queue'),
  );
  app.get('/v1/patients/:patientId/episodes/:id/review', { config: session }, (request, reply) =>
    pass(
      request,
      reply,
      'GET',
      `/v1/patients/${patient(request)}/episodes/${episode(request)}/review`,
    ),
  );
  app.post(
    '/v1/patients/:patientId/episodes/:id/decision',
    { config: session, bodyLimit: 8192, schema: { body: { type: 'object' } } },
    (request, reply) =>
      pass(
        request,
        reply,
        'POST',
        `/v1/patients/${patient(request)}/episodes/${episode(request)}/decision`,
      ),
  );
  app.get('/v1/patients/:patientId/surgery-checks', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', `/v1/patients/${patient(request)}/surgery-checks`),
  );
  for (const suffix of ['', '/preview'] as const)
    app.post(
      `/v1/patients/:patientId/surgery-checks${suffix}`,
      { config: session, bodyLimit: 2048, schema: { body: { type: 'object' } } },
      (request, reply) =>
        pass(request, reply, 'POST', `/v1/patients/${patient(request)}/surgery-checks${suffix}`),
    );

  // M5 organisation admin (REQ-010): settings and members. The API allows org_admin only.
  app.get('/v1/org/settings', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/org/settings'),
  );
  app.post(
    '/v1/org/settings',
    { config: session, bodyLimit: 2048, schema: { body: { type: 'object' } } },
    (request, reply) => pass(request, reply, 'POST', '/v1/org/settings'),
  );
  app.get('/v1/org/clinicians', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/org/clinicians'),
  );
  app.post(
    '/v1/org/clinicians/:id',
    { config: session, bodyLimit: 256, schema: { body: { type: 'object' } } },
    (request, reply) => {
      const id = (request.params as { id?: string }).id ?? '';
      if (!UUID.test(id)) throw new ProblemError(404, 'clinician.not_found', 'Not found.');
      return pass(request, reply, 'POST', `/v1/org/clinicians/${id}`);
    },
  );

  // REQ-010 staff invitations: made, listed and stopped by the org admin.
  app.get('/v1/org/staff-invitations', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/org/staff-invitations'),
  );
  app.post(
    '/v1/org/staff-invitations',
    { config: session, bodyLimit: 256, schema: { body: { type: 'object' } } },
    (request, reply) => pass(request, reply, 'POST', '/v1/org/staff-invitations'),
  );
  app.post(
    '/v1/org/staff-invitations/:id/revoke',
    { config: session, bodyLimit: 64, schema: { body: { type: 'object' } } },
    (request, reply) => {
      const id = (request.params as { id?: string }).id ?? '';
      if (!UUID.test(id)) throw new ProblemError(404, 'staff_invitation.not_open', 'Not found.');
      return pass(request, reply, 'POST', `/v1/org/staff-invitations/${id}/revoke`);
    },
  );

  // REQ-011: the aggregate dashboard of the session's organisation (never one the browser names).
  app.get('/v1/dashboard', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', `/v1/orgs/${request.session?.active?.orgId ?? 'none'}/dashboard`),
  );
}
