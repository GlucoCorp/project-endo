import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProblemError } from '@endo/service-kit';
import type { EnrolmentDeps } from './enrolment.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/**
 * Her email for the sign-in fallback (spec 10.1, 21.7 screen 9; ADR-0026): she adds an address,
 * a code goes to it, and she types the code to confirm it. Only for her own signed-in, unlocked
 * session: the person comes from the session, never from the request. The page never sees an
 * address it did not send, and no address appears in a log or error.
 */
export function registerEmailSettings(app: FastifyInstance, deps: EnrolmentDeps): void {
  const unavailable = () =>
    new ProblemError(502, 'upstream_unavailable', 'This is not available right now.');
  const json = (request: FastifyRequest): Promise<void> => {
    if (request.headers.origin !== deps.patientOrigin)
      return Promise.reject(new ProblemError(403, 'csrf.origin_mismatch', 'Request refused.'));
    if (!/^application\/json(;|$)/.test(request.headers['content-type'] ?? ''))
      return Promise.reject(new ProblemError(415, 'request.json_required', 'Request refused.'));
    return Promise.resolve();
  };
  const call = async (request: FastifyRequest, path: string, body: object) => {
    const token = await deps.signer.sign(['identity.email.patient'], 'identity');
    try {
      return await deps.fetch(new URL(path, deps.identityBaseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': request.id,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unavailable();
    }
  };
  const person = (request: FastifyRequest): string => {
    if (request.claims?.role !== 'patient')
      throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    return request.claims.sub;
  };

  app.post(
    '/v1/settings/email',
    {
      config: { auth: { kind: 'session' } },
      preValidation: json,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['address'],
          properties: {
            address: {
              type: 'string',
              minLength: 3,
              maxLength: 254,
              pattern: '^[^\\s@]+@[^\\s@]+$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.body as { address: string };
      const res = await call(request, '/internal/v1/email-codes/confirm', {
        person_id: person(request),
        address,
        source_ip: request.ip,
      });
      if (res.status !== 202) throw unavailable();
      const id = ((await res.json().catch(() => null)) as { request_id?: unknown } | null)
        ?.request_id;
      if (typeof id !== 'string' || !new RegExp(UUID).test(id)) throw unavailable();
      return reply.code(202).send({ request_id: id });
    },
  );

  app.post(
    '/v1/settings/email/confirm',
    {
      config: { auth: { kind: 'session' } },
      preValidation: json,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['request_id', 'code'],
          properties: {
            request_id: { type: 'string', pattern: UUID },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { request_id: string; code: string };
      const res = await call(request, '/internal/v1/email-codes/confirm/verify', {
        person_id: person(request),
        request_id: b.request_id,
        code: b.code,
      });
      if (res.status === 403)
        throw new ProblemError(400, 'email_code.refused', 'That code did not work.');
      if (res.status !== 204) throw unavailable();
      return reply.code(204).send();
    },
  );
}
