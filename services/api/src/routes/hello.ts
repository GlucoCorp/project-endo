import type { FastifyInstance } from 'fastify';

/**
 * M0 walking skeleton (spec 22): proves a request passes BFF -> service token -> authz -> audit.
 * Returns no health data. Removed or kept as a smoke-test route once real routes exist.
 */
export function registerHelloRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/hello',
    {
      config: {
        policy: {
          kind: 'protected',
          action: 'system.hello',
          resourceType: 'system',
          purpose: 'system_check',
          resource: (_req, subject) => ({
            type: 'system',
            id: null,
            orgId: subject.orgId,
            patientId: null,
          }),
        },
      },
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['message', 'role', 'request_id'],
            properties: {
              message: { type: 'string' },
              role: { type: 'string' },
              request_id: { type: 'string' },
            },
          },
        },
      },
    },
    (request) => ({
      message: 'hello',
      // onRequest guarantees a subject on protected routes.
      role: request.subject?.role ?? 'unknown',
      request_id: request.id,
    }),
  );
}
