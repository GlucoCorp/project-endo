import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  ServiceTokenSigner,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { createBffInstance } from './app.ts';
import { registerHistoryProxy } from './history.ts';
import { DevSessionStore, SESSION_COOKIE } from './sessions.ts';

const ORIGIN = 'https://patient.test';
const TOKEN = 'T'.repeat(43);
const CLAIMS = {
  sub: '01900000-0000-7000-8000-0000000000f1',
  role: 'patient' as const,
  org_id: '01900000-0000-7000-8000-00000000000a',
  patient_id: '01900000-0000-7000-8000-0000000000a1',
};

async function setup(reply: (url: URL, init: RequestInit) => Response) {
  const service = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const sessions = new DevSessionStore('test');
  const seen: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push({ url, init: init ?? {} });
    return Promise.resolve(reply(url, init ?? {}));
  }) as typeof fetch;
  const app = await createBffInstance({
    logLevel: 'silent',
    sessions,
    signer: new ServiceTokenSigner(service.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: fetchImpl,
  });
  registerHistoryProxy(app, {
    signer: new ServiceTokenSigner(service.privateJwk, 'bff-patient'),
    workload: new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    patientOrigin: ORIGIN,
    fetch: fetchImpl,
  });
  await app.ready();
  const verifier = new WorkloadTokenVerifier('api', {
    'bff-patient': { publicJwk: workload.publicJwk, scopes: ['api.share.view'] },
  });
  return { app, seen, cookie: `${SESSION_COOKIE}=${sessions.create(CLAIMS)}`, verifier };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('REQ-008 the receiver view and her history through the BFF', () => {
  it('hashes the link token and asks the API with the workload key; the token never travels', async () => {
    const { app, seen, verifier } = await setup(() => json(200, { treatments: [] }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shared/view',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(seen[0]?.url.pathname).toBe('/internal/v1/shared/view');
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
      token_hash: createHash('sha256').update(TOKEN).digest('hex'),
    });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    const caller = await verifier.verifyHeader(
      new Headers(seen[0]?.init.headers).get('authorization') ?? undefined,
    );
    expect(caller.scopes).toEqual(['api.share.view']);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/shared/view',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { token: 'short' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('answers the same for a link that cannot be used', async () => {
    const { app } = await setup(() => json(404, {}));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shared/view',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toMatch(/share_link\.not_found$/);
  });

  it('passes her history, links and access log; a stop needs her origin', async () => {
    const { app, cookie, seen } = await setup((url) =>
      url.pathname.startsWith('/v1/me/share-links/')
        ? new Response(null, { status: 204 })
        : json(200, { ok: true }),
    );
    for (const p of [
      '/v1/me/history',
      '/v1/me/share-links',
      '/v1/me/access-log',
      '/v1/me/surgery-checks',
    ])
      expect((await app.inject({ url: p, headers: { cookie } })).statusCode).toBe(200);
    const made = await app.inject({
      method: 'POST',
      url: '/v1/me/share-links',
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { days: 7 },
    });
    expect(made.statusCode).toBe(200);
    const id = '01900000-0000-7000-8000-0000000000d9';
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/me/share-links/${id}`,
          headers: { cookie, origin: ORIGIN },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/me/share-links/${id}`,
          headers: { cookie, origin: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/me/share-links/nope',
          headers: { cookie, origin: ORIGIN },
        })
      ).statusCode,
    ).toBe(404);
    expect(seen.some((s) => s.init.method === 'DELETE')).toBe(true);
    expect((await app.inject({ url: '/v1/me/history' })).statusCode).toBe(401);
  });
});
