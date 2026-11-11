import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProblemError } from '@endo/service-kit';
import { SESSION_COOKIE, readCookie, type SessionResolver } from './sessions.ts';

/**
 * Her session as the page sees it, and app lock (spec 10.1; RISK-S02): an optional lock for
 * shared phones. Locked, the session reaches nothing but this state; she unlocks by signing in
 * again with her passkey (always a fresh authentication with user verification). Never her ids.
 */
export function registerSessionRoutes(app: FastifyInstance, sessions: SessionResolver): void {
  const token = (request: FastifyRequest) => readCookie(request.headers.cookie, SESSION_COOKIE);
  // These change state: the exact page origin is checked by the JSON body requirement, which a
  // cross-site form cannot send without a preflight this service never allows.
  const json = (request: FastifyRequest): Promise<void> =>
    /^application\/json(;|$)/.test(request.headers['content-type'] ?? '')
      ? Promise.resolve()
      : Promise.reject(new ProblemError(415, 'request.json_required', 'Request refused.'));

  app.get(
    '/v1/session',
    { config: { auth: { kind: 'session', allowLocked: true } } },
    async (request) => {
      const s = await sessions.resolve(token(request) ?? '');
      return { signed_in: true, locked: s?.locked ?? true, app_lock: s?.appLock ?? false };
    },
  );

  app.post(
    '/v1/session/app-lock',
    {
      config: { auth: { kind: 'session' } },
      preValidation: json,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const { enabled } = request.body as { enabled: boolean };
      if (!(await sessions.setAppLock(token(request) ?? '', enabled)))
        throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
      return { app_lock: enabled };
    },
  );

  /** The page asks this when she leaves the app; it locks only if she turned app lock on. */
  app.post(
    '/v1/session/lock',
    { config: { auth: { kind: 'session', allowLocked: true } }, preValidation: json },
    async (request, reply) => {
      await sessions.lock(token(request) ?? '');
      return reply.code(204).send();
    },
  );
}
