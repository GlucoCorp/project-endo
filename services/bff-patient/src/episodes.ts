import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, type ServiceTokenSigner } from '@endo/service-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EpisodeProxyDeps {
  readonly signer: ServiceTokenSigner;
  readonly apiBaseUrl: string;
  readonly patientOrigin: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Her episodes, goal, weekly check-ins and red flags (M2), passed to the API with a service token
 * minted per call from her session (spec 8.4). A fixed list of routes, nothing generic:
 *
 * - The episode id is checked as a UUID before it goes into a path.
 * - State changes need this origin exactly, a JSON body and a UUID Idempotency-Key, which is
 *   passed on so her app's retries (and offline replays) are safe (spec 9.1).
 * - Only the API's problem code and generic title come back on errors; never an upstream body
 *   beyond that, and never her answers (spec 2.3, 9.1).
 */
export function registerEpisodeProxy(app: FastifyInstance, deps: EpisodeProxyDeps): void {
  const timeoutMs = deps.timeoutMs ?? 10_000;

  const guard = (request: FastifyRequest): Promise<void> => {
    if (request.headers.origin !== deps.patientOrigin)
      return Promise.reject(new ProblemError(403, 'csrf.origin_mismatch', 'Request refused.'));
    if (!/^application\/json(;|$)/.test(request.headers['content-type'] ?? ''))
      return Promise.reject(new ProblemError(415, 'request.json_required', 'Request refused.'));
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !UUID.test(key))
      return Promise.reject(
        new ProblemError(400, 'request.idempotency_key_required', 'Request refused.'),
      );
    return Promise.resolve();
  };

  const pass = async (
    request: FastifyRequest,
    reply: FastifyReply,
    method: 'GET' | 'POST',
    path: string,
  ) => {
    if (!request.claims || request.claims.role !== 'patient')
      throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    const token = await deps.signer.sign(request.claims, 'api');
    let res: Response;
    try {
      res = await deps.fetch(new URL(path, deps.apiBaseUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': request.id,
          accept: 'application/json',
          ...(method === 'POST'
            ? {
                'content-type': 'application/json',
                'idempotency-key': request.headers['idempotency-key'] as string,
              }
            : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new ProblemError(502, 'upstream_unavailable', 'This is not available right now.');
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body) return reply.code(res.status).send(body);
    if (res.status === 401 || res.status === 403)
      throw new ProblemError(
        res.status,
        res.status === 401 ? 'authn.rejected' : 'authz.denied',
        'You do not have access to this.',
      );
    if ([400, 404, 409, 422].includes(res.status)) {
      // The API's code (from its problem type) and nothing else.
      const type = typeof body?.['type'] === 'string' ? body['type'] : '';
      const code = /([a-z_]+\.[a-z_.]+)$/.exec(type)?.[1] ?? 'request.refused';
      throw new ProblemError(
        res.status,
        code,
        res.status === 404 ? 'Not found.' : 'This could not be saved.',
      );
    }
    throw new ProblemError(502, 'upstream_error', 'This is not available right now.');
  };

  const episodeId = (request: FastifyRequest) => {
    const id = (request.params as { id?: string }).id ?? '';
    if (!UUID.test(id)) throw new ProblemError(404, 'episode.not_found', 'Not found.');
    return id;
  };
  const session = { auth: { kind: 'session' } } as const;

  app.get('/v1/me/episodes', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/me/episodes'),
  );
  app.get('/v1/me/checkin-content', { config: session }, (request, reply) =>
    pass(request, reply, 'GET', '/v1/me/checkin-content'),
  );
  for (const action of ['confirm', 'checkins', 'red-flags'] as const) {
    app.post(
      `/v1/episodes/:id/${action}`,
      {
        config: session,
        preValidation: guard,
        bodyLimit: 8192,
        // Shape is checked by the API against the instrument; here only that it is an object.
        schema: { body: { type: 'object' } },
      },
      (request, reply) =>
        pass(request, reply, 'POST', `/v1/episodes/${episodeId(request)}/${action}`),
    );
  }
  // Spec 15: her weekly reminder on this device (the API checks the push endpoint).
  for (const path of ['/v1/me/push-subscriptions', '/v1/me/push-subscriptions/remove'] as const) {
    app.post(
      path,
      {
        config: session,
        preValidation: guard,
        bodyLimit: 4096,
        schema: { body: { type: 'object' } },
      },
      (request, reply) => pass(request, reply, 'POST', path),
    );
  }
}
