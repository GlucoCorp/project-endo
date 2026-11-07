import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { rateLimitedError, registerProblemHandlers } from './index.ts';

describe('RISK-D01 rate-limited problem response', () => {
  it('maps to 429 with generic text', async () => {
    const app = Fastify();
    registerProblemHandlers(app);
    app.get('/a', () => {
      throw rateLimitedError();
    });
    app.get('/b', () => {
      throw Object.assign(new Error('limit for 10.0.0.1 exceeded'), { statusCode: 429 });
    });
    for (const url of ['/a', '/b']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ type: 'https://errors.glucorp.health/rate_limited' });
      expect(res.body).not.toContain('10.0.0.1');
    }
  });
});
