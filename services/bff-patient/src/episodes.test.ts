import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { createBffInstance } from './app.ts';
import { registerEpisodeProxy } from './episodes.ts';
import { DevSessionStore, SESSION_COOKIE } from './sessions.ts';

const ORIGIN = 'https://patient.test';
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const CLAIMS = {
  sub: '01900000-0000-7000-8000-0000000000f1',
  role: 'patient' as const,
  org_id: '01900000-0000-7000-8000-00000000000a',
  patient_id: '01900000-0000-7000-8000-0000000000a1',
};
const MARKER = 'SYNTHETIC_PHI_MARKER-answers-7f3a';

async function setup(reply: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const keys = await generateServiceKeyPair();
  const sessions = new DevSessionStore('test');
  const seen: { url: URL; init: RequestInit }[] = [];
  const logs: string[] = [];
  const app = await createBffInstance({
    logLevel: 'info',
    logStream: { write: (l) => logs.push(l) },
    sessions,
    signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      seen.push({ url, init: init ?? {} });
      return reply(url, init ?? {});
    },
  });
  registerEpisodeProxy(app, {
    signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    patientOrigin: ORIGIN,
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      seen.push({ url, init: init ?? {} });
      return reply(url, init ?? {});
    },
  });
  await app.ready();
  const cookie = `${SESSION_COOKIE}=${sessions.create(CLAIMS)}`;
  const verifier = new ServiceTokenVerifier('api', {
    'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
  });
  const post = (path: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        ...headers,
      },
      payload,
    });
  return { app, seen, cookie, verifier, post, logs, sessions };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('REQ-002, REQ-003, REQ-007 the patient BFF passes her episode calls to the API', () => {
  it('reads her episodes with a service token minted from her session', async () => {
    const { app, seen, cookie, verifier } = await setup(() => json(200, { episodes: [] }));
    const res = await app.inject({ url: '/v1/me/episodes', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ episodes: [] });
    expect(seen[0]?.url.href).toBe('http://api.internal/v1/me/episodes');
    const claims = await verifier.verifyHeader(
      new Headers(seen[0]?.init.headers).get('authorization') ?? undefined,
    );
    expect(claims).toMatchObject({ role: 'patient', patient_id: CLAIMS.patient_id });
    // Not signed in: refused here.
    expect((await app.inject({ url: '/v1/me/episodes' })).statusCode).toBe(401);
  });

  it('passes a check-in with its Idempotency-Key, only from her app’s origin, as JSON', async () => {
    const { post, seen } = await setup(() => json(201, { id: 'x', week_index: 1 }));
    const key = randomUUID();
    const res = await post(
      `/v1/episodes/${EPISODE}/checkins`,
      { week_index: 1 },
      { 'idempotency-key': key },
    );
    expect(res.statusCode).toBe(201);
    expect(seen[0]?.url.pathname).toBe(`/v1/episodes/${EPISODE}/checkins`);
    expect(new Headers(seen[0]?.init.headers).get('idempotency-key')).toBe(key);
    expect(
      (await post(`/v1/episodes/${EPISODE}/checkins`, {}, { origin: 'https://evil.test' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(`/v1/episodes/${EPISODE}/checkins`, {}, { 'content-type': 'text/plain' }))
        .statusCode,
    ).toBe(415);
    expect(
      (await post(`/v1/episodes/${EPISODE}/checkins`, {}, { 'idempotency-key': 'nope' }))
        .statusCode,
    ).toBe(400);
    expect((await post('/v1/episodes/not-a-uuid/checkins', {})).statusCode).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it('returns only the API’s code on refusal, never its body or her answers', async () => {
    const { post, logs } = await setup(() =>
      json(422, {
        type: 'https://errors.endo.example/checkin.invalid_answers',
        title: 'Some answers could not be saved.',
        detail: MARKER,
      }),
    );
    const res = await post(`/v1/episodes/${EPISODE}/checkins`, { answers: { Q2: MARKER } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ type: string }>().type).toMatch(/checkin\.invalid_answers$/);
    expect(res.body).not.toContain(MARKER);
    expect(logs.join('\n')).not.toContain(MARKER);
  });

  it('maps an unreachable or failing API to a generic 502', async () => {
    const down = await setup(() => {
      throw new TypeError('down');
    });
    expect(
      (await down.app.inject({ url: '/v1/me/episodes', headers: { cookie: down.cookie } }))
        .statusCode,
    ).toBe(502);
    const broken = await setup(() => json(500, { secret: 'x' }));
    const res = await broken.app.inject({
      url: '/v1/me/checkin-content',
      headers: { cookie: broken.cookie },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret');
    const denied = await setup(() => json(403, {}));
    expect((await denied.post(`/v1/episodes/${EPISODE}/confirm`, {})).statusCode).toBe(403);
  });

  it('passes her reminder subscription with the same checks (spec 15)', async () => {
    const { post, seen } = await setup(() => json(201, { subscribed: true }));
    expect(
      (await post('/v1/me/push-subscriptions', { endpoint: 'x', time_zone: 'UTC' })).statusCode,
    ).toBe(201);
    expect(seen[0]?.url.pathname).toBe('/v1/me/push-subscriptions');
    expect(
      (await post('/v1/me/push-subscriptions/remove', {}, { origin: 'https://evil.test' }))
        .statusCode,
    ).toBe(403);
  });

  it('is refused while the app is locked (spec 10.1)', async () => {
    const { app, sessions } = await setup(() => json(200, { episodes: [] }));
    const token = sessions.create(CLAIMS, true);
    await sessions.lock(token);
    const res = await app.inject({
      url: '/v1/me/episodes',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('spec 14 service worker and app config', () => {
  it('serves the service worker for the whole app, caching the shell but never /v1 or /auth', async () => {
    const { buildBff } = await import('./app.ts');
    const keys = await generateServiceKeyPair();
    const app = await buildBff({
      logLevel: 'silent',
      sessions: new DevSessionStore('test'),
      signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
      apiBaseUrl: 'http://api.internal',
      fetch: () => Promise.reject(new Error('no')),
      emergencyNumber: '112',
    });
    const sw = await app.inject({ url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['service-worker-allowed']).toBe('/');
    expect(sw.headers['content-type']).toMatch(/javascript/);
    expect(sw.body).toContain("url.pathname.startsWith('/v1/')");
    expect(sw.body).toContain('Your weekly check-in is ready.');
    const config = await app.inject({ url: '/v1/app-config' });
    expect(config.json()).toEqual({ emergency_number: '112', vapid_public_key: null });
    expect(config.headers['cache-control']).toBe('no-store');
  });
});
