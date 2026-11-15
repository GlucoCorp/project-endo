import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, type ServiceTokenSigner, type WorkloadTokenSigner } from '@endo/service-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HistoryProxyDeps {
  readonly signer: ServiceTokenSigner;
  /** The BFF's workload key: the receiver's view of a share link, `api.share.view` only. */
  readonly workload: WorkloadTokenSigner;
  readonly apiBaseUrl: string;
  readonly patientOrigin: string;
  readonly fetch: typeof fetch;
}

/**
 * Her history, share links, access log and pre-surgery checks (REQ-008, REQ-006; spec 13.3), and
 * the receiver's view of a share link.
 *
 * The receiver is not signed in: the page reads the token from the link's fragment and posts it
 * here; this BFF hashes it, so the token never reaches the API, a log or a URL path, and asks the
 * API with its own workload key. The same answer for a wrong, stopped or expired link.
 */
export function registerHistoryProxy(app: FastifyInstance, deps: HistoryProxyDeps): void {
  const guard = (request: FastifyRequest, needKey: boolean): Promise<void> => {
    if (request.headers.origin !== deps.patientOrigin)
      return Promise.reject(new ProblemError(403, 'csrf.origin_mismatch', 'Request refused.'));
    if (
      request.method !== 'DELETE' &&
      !/^application\/json(;|$)/.test(request.headers['content-type'] ?? '')
    )
      return Promise.reject(new ProblemError(415, 'request.json_required', 'Request refused.'));
    const key = request.headers['idempotency-key'];
    if (needKey && (typeof key !== 'string' || !UUID.test(key)))
      return Promise.reject(
        new ProblemError(400, 'request.idempotency_key_required', 'Request refused.'),
      );
    return Promise.resolve();
  };
  const call = async (url: string, init: RequestInit) => {
    try {
      return await deps.fetch(new URL(url, deps.apiBaseUrl), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProblemError(502, 'upstream_unavailable', 'This is not available right now.');
    }
  };
  const answer = async (res: Response, reply: FastifyReply) => {
    if (res.status === 204) return reply.code(204).send();
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body) return reply.code(res.status).send(body);
    if (res.status === 401 || res.status === 403)
      throw new ProblemError(
        res.status,
        res.status === 401 ? 'authn.rejected' : 'authz.denied',
        'You do not have access to this.',
      );
    if ([400, 404, 409, 422].includes(res.status)) {
      const type = typeof body?.['type'] === 'string' ? body['type'] : '';
      throw new ProblemError(
        res.status,
        /([a-z_]+\.[a-z_.]+)$/.exec(type)?.[1] ?? 'request.refused',
        'This could not be done.',
      );
    }
    throw new ProblemError(502, 'upstream_error', 'This is not available right now.');
  };
  const pass = async (
    request: FastifyRequest,
    reply: FastifyReply,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
  ) => {
    if (!request.claims || request.claims.role !== 'patient')
      throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    const token = await deps.signer.sign(request.claims, 'api');
    const res = await call(path, {
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
    });
    return answer(res, reply);
  };
  const session = { auth: { kind: 'session' } } as const;

  for (const path of [
    '/v1/me/history',
    '/v1/me/share-links',
    '/v1/me/access-log',
    '/v1/me/surgery-checks',
  ] as const)
    app.get(path, { config: session }, (request, reply) => pass(request, reply, 'GET', path));
  app.post(
    '/v1/me/share-links',
    {
      config: session,
      preValidation: (r) => guard(r, true),
      bodyLimit: 1024,
      schema: { body: { type: 'object' } },
    },
    (request, reply) => pass(request, reply, 'POST', '/v1/me/share-links'),
  );
  app.delete(
    '/v1/me/share-links/:id',
    { config: session, preValidation: (r) => guard(r, false) },
    (request, reply) => {
      const id = (request.params as { id: string }).id;
      if (!UUID.test(id)) throw new ProblemError(404, 'share_link.not_found', 'Not found.');
      return pass(request, reply, 'DELETE', `/v1/me/share-links/${id}`);
    },
  );

  /** The receiver's view (no sign-in): the token comes in the body, never in a URL. */
  app.post(
    '/v1/shared/view',
    {
      config: { auth: { kind: 'public', reason: 'shared-view' } },
      preValidation: (r) => guard(r, false),
      bodyLimit: 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      const res = await call('/internal/v1/shared/view', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await deps.workload.sign(['api.share.view'], 'api')}`,
          'x-request-id': request.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token_hash: createHash('sha256').update(token).digest('hex') }),
      });
      if (res.status === 404)
        throw new ProblemError(
          404,
          'share_link.not_found',
          'This link cannot be used. Ask for a new one.',
        );
      return answer(res, reply.header('cache-control', 'no-store'));
    },
  );
}
