import type { FastifyInstance } from 'fastify';

/** Liveness only. Returns no data and touches nothing (spec 17). */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', { config: { policy: { kind: 'public', reason: 'liveness' } } }, () => ({
    status: 'ok',
  }));
}
