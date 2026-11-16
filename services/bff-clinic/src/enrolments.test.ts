import { describe, expect, it } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildClinicBff } from './app.ts';
import { SeenTokenIds, TransactionStore, type OidcConfig } from './oidc.ts';
import { InMemoryClinicSessions, SESSION_COOKIE } from './sessions.ts';

const ISSUER = 'https://kc.test/realms/endo-dev';
const ORIGIN = 'https://clinic.test';
const PERSON = '01900000-0000-7000-8000-0000000000e1';
const ORG = '01900000-0000-7000-8000-00000000000a';
const INVITATION = '01900000-0000-7000-8000-0000000000d1';
const CONFIG: OidcConfig = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/auth`,
  tokenEndpoint: `${ISSUER}/token`,
  clientId: 'bff-clinician',
  clientSecret: 'test-secret',
  redirectUri: `${ORIGIN}/auth/callback`,
  requiredAcr: '1',
  endSessionEndpoint: `${ISSUER}/logout`,
  postLogoutRedirectUri: `${ORIGIN}/`,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup(api: (req: Request) => Response | Promise<Response>, confirmsPerMinute = 10) {
  const keys = await generateServiceKeyPair();
  const seen: Request[] = [];
  const sessions = new InMemoryClinicSessions('test');
  const app = await buildClinicBff({
    logLevel: 'silent',
    oidc: CONFIG,
    keys: createLocalJWKSet({ keys: [] }),
    transactions: new TransactionStore(),
    logoutTokens: new SeenTokenIds(),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/identity'),
    sessions,
    resolver: {
      person: () => Promise.resolve(null),
      // Choosing an organisation re-checks the clinician's current memberships.
      memberships: () => Promise.resolve([{ orgId: ORG, role: 'clinician' as const }]),
    },
    fetch: () => Promise.reject(new Error('unused')),
    now: () => new Date(),
    portalOrigin: ORIGIN,
    enrolment: {
      apiBaseUrl: 'http://api.internal',
      signer: new ServiceTokenSigner(keys.privateJwk, 'bff-clinic'),
      fetch: (input, init) => {
        const r = new Request(input, init);
        seen.push(r);
        return Promise.resolve(api(r));
      },
      now: () => new Date(),
      confirmsPerMinute,
    },
  });
  const token = await sessions.create({
    personId: PERSON,
    issuer: ISSUER,
    subject: 'kc-1',
    sid: null,
    idToken: 'id',
    refresh: await new EnvelopeSealer(new DevKeyManager('test'), 'kms/identity').seal('rt', 'ctx'),
    memberships: [{ orgId: ORG, role: 'clinician' }],
  });
  const cookie = `${SESSION_COOKIE}=${token}`;
  const csrf = (await app.inject({ url: '/v1/session', headers: { cookie } })).json<{
    csrf_token: string;
  }>().csrf_token;
  const chosen = await app.inject({
    method: 'POST',
    url: '/v1/session/organisation',
    headers: { cookie, 'x-csrf-token': csrf, origin: ORIGIN },
    payload: { index: 0 },
  });
  if (chosen.statusCode !== 200)
    throw new Error(`choose: ${String(chosen.statusCode)} ${chosen.body}`);
  const active = String(chosen.headers['set-cookie']).split(';')[0] ?? cookie;
  const activeCsrf = chosen.json<{ csrf_token: string }>().csrf_token;
  const verifier = new ServiceTokenVerifier('api', {
    'bff-clinic': { publicJwk: keys.publicJwk, roles: ['clinician'] },
  });
  const confirm = (payload: object, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/enrolments/${INVITATION}/confirm`,
      headers: { cookie: active, 'x-csrf-token': activeCsrf, origin: ORIGIN, ...headers },
      payload,
    });
  return { app, seen, active, activeCsrf, confirm, verifier };
}

const good = { code: '123456', identified: true, own_phone: true };

describe('REQ-001 ADR-0021 slice 3: the clinic portal lists invitations and confirms by code', () => {
  it('lists invitations through the API as the signed-in clinician of the chosen organisation', async () => {
    const { app, seen, active, verifier } = await setup(() =>
      json(200, {
        invitations: [
          {
            id: INVITATION,
            created_at: '2026-11-11T09:00:00Z',
            expires_at: '2026-11-18T09:00:00Z',
            in_use: false,
          },
        ],
      }),
    );
    const res = await app.inject({ url: '/v1/enrolments', headers: { cookie: active } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      invitations: [
        {
          id: INVITATION,
          created_at: '2026-11-11T09:00:00Z',
          expires_at: '2026-11-18T09:00:00Z',
          in_use: false,
        },
      ],
    });
    const claims = await verifier.verifyHeader(seen[0]?.headers.get('authorization') ?? undefined);
    expect(claims).toMatchObject({ sub: PERSON, role: 'clinician', org_id: ORG, patient_id: null });
  });

  it('confirms by code, passing the attestation on to the API', async () => {
    const { confirm, seen } = await setup(() => json(200, { outcome: 'confirmed' }));
    const res = await confirm(good);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'confirmed' });
    expect(seen[0]?.url).toBe(`http://api.internal/v1/enrolments/${INVITATION}/confirm`);
    expect(await seen[0]?.json()).toEqual(good);
  });

  it.each([
    [{ outcome: 'wrong', remaining: 2 }],
    [{ outcome: 'locked', locked_until: '2026-11-11T12:00:00Z' }],
    [{ outcome: 'unavailable' }],
  ])('passes on %o', async (body) => {
    const { confirm } = await setup(() => json(200, body));
    expect((await confirm(good)).json()).toEqual(body);
  });

  it('needs CSRF, the attestation and a well-formed code; never calls the API otherwise', async () => {
    const { confirm, seen } = await setup(() => json(200, { outcome: 'confirmed' }));
    expect((await confirm(good, { origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await confirm(good, { 'x-csrf-token': 'x'.repeat(43) })).statusCode).toBe(403);
    expect((await confirm({ ...good, own_phone: false })).statusCode).toBe(400);
    expect((await confirm({ ...good, code: '1234' })).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('limits code entries per clinician', async () => {
    const { confirm } = await setup(() => json(200, { outcome: 'wrong', remaining: 4 }), 3);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await confirm(good)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('never passes upstream errors or unexpected answers through', async () => {
    for (const [answer, status] of [
      [json(403, {}), 403],
      [json(500, { detail: 'secret' }), 502],
      [json(200, { outcome: 'maybe' }), 502],
      [new Response('nope', { status: 200 }), 502],
    ] as const) {
      const { confirm, app, active } = await setup(() => answer.clone());
      const res = await confirm(good);
      expect(res.statusCode).toBe(status);
      expect(res.body).not.toContain('secret');
      const list = await app.inject({ url: '/v1/enrolments', headers: { cookie: active } });
      expect(list.statusCode).toBe(status === 403 ? 403 : 502);
    }
  });

  it('refuses without a session', async () => {
    const { app } = await setup(() => json(200, {}));
    expect((await app.inject({ url: '/v1/enrolments' })).statusCode).toBe(401);
  });
});

describe('REQ-002 the clinic portal drafts treatment episodes through the API', () => {
  const PATIENT = '01900000-0000-7000-8000-0000000000a1';
  it('lists the catalogue and sharing patients, and drafts with CSRF and an Idempotency-Key', async () => {
    const { app, seen, active, activeCsrf } = await setup((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/v1/catalogue') return json(200, { treatments: [] });
      if (path === '/v1/patients') return json(200, { patients: [{ id: PATIENT }] });
      return json(201, { id: 'e', status: 'draft' });
    });
    expect(
      (await app.inject({ url: '/v1/catalogue', headers: { cookie: active } })).statusCode,
    ).toBe(200);
    const pts = await app.inject({ url: '/v1/patients', headers: { cookie: active } });
    expect(pts.json()).toEqual({ patients: [{ id: PATIENT }] });
    const key = '0190a000-0000-4000-8000-000000000001';
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/v1/patients/${PATIENT}/episodes`,
        headers: { cookie: active, origin: ORIGIN, 'content-type': 'application/json', ...headers },
        payload: { dose_text: 'x' },
      });
    const ok = await post({ 'x-csrf-token': activeCsrf, 'idempotency-key': key });
    expect(ok.statusCode).toBe(201);
    const last = seen[seen.length - 1];
    expect(last?.headers.get('idempotency-key')).toBe(key);
    expect(new URL(last?.url ?? 'http://x').pathname).toBe(`/v1/patients/${PATIENT}/episodes`);
    expect((await post({ 'idempotency-key': key })).statusCode).toBe(403); // no CSRF
    expect((await post({ 'x-csrf-token': activeCsrf })).statusCode).toBe(400); // no key
    const bad = await app.inject({
      url: '/v1/patients/nope/episodes',
      headers: { cookie: active },
    });
    expect(bad.statusCode).toBe(404);
  });

  it('passes on only the API code when it refuses (for example, no consent)', async () => {
    const { app, active } = await setup(() =>
      json(422, { type: 'https://e/episode.unknown_treatment', detail: 'secret' }),
    );
    const res = await app.inject({
      url: `/v1/patients/${PATIENT}/episodes`,
      headers: { cookie: active },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain('secret');
    const denied = await setup(() => json(403, {}));
    expect(
      (await denied.app.inject({ url: '/v1/patients', headers: { cookie: denied.active } }))
        .statusCode,
    ).toBe(403);
    const down = await setup(() => Promise.reject(new TypeError('down')));
    expect(
      (await down.app.inject({ url: '/v1/catalogue', headers: { cookie: down.active } }))
        .statusCode,
    ).toBe(502);
  });
});

describe('REQ-005, REQ-006 the clinic desk passes the review calls to the API', () => {
  const PATIENT = '01900000-0000-7000-8000-0000000000a1';
  const EPISODE = '01900000-0000-7000-8000-0000000000e5';
  it('reads the queue and review, and posts the decision and pre-surgery check with CSRF', async () => {
    const { app, seen, active, activeCsrf } = await setup(() => json(200, { ok: true }));
    expect(
      (await app.inject({ url: '/v1/reviews/queue', headers: { cookie: active } })).statusCode,
    ).toBe(200);
    const review = `/v1/patients/${PATIENT}/episodes/${EPISODE}/review`;
    expect((await app.inject({ url: review, headers: { cookie: active } })).statusCode).toBe(200);
    expect(new URL(seen[seen.length - 1]?.url ?? 'http://x').pathname).toBe(review);
    const post = (url: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          cookie: active,
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': activeCsrf,
          'idempotency-key': '0190a000-0000-4000-8000-000000000002',
          ...headers,
        },
        payload: { decision: 'stop' },
      });
    expect((await post(`/v1/patients/${PATIENT}/episodes/${EPISODE}/decision`)).statusCode).toBe(
      200,
    );
    expect((await post(`/v1/patients/${PATIENT}/surgery-checks/preview`)).statusCode).toBe(200);
    expect((await post(`/v1/patients/${PATIENT}/surgery-checks`)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: `/v1/patients/${PATIENT}/surgery-checks`,
          headers: { cookie: active },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post(`/v1/patients/${PATIENT}/episodes/${EPISODE}/decision`, {
          'x-csrf-token': 'wrong',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/v1/patients/${PATIENT}/episodes/nope/review`,
          headers: { cookie: active },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('REQ-010 the clinic desk passes organisation admin calls to the API', () => {
  it('reads and saves settings and members with CSRF; a bad member id never reaches the API', async () => {
    const { app, seen, active, activeCsrf } = await setup(() => json(200, { ok: true }));
    for (const url of ['/v1/org/settings', '/v1/org/clinicians'])
      expect((await app.inject({ url, headers: { cookie: active } })).statusCode).toBe(200);
    const post = (url: string, payload: object) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          cookie: active,
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': activeCsrf,
          'idempotency-key': '0190a000-0000-4000-8000-000000000003',
        },
        payload,
      });
    expect(
      (await post('/v1/org/settings', { languages: ['en'], emergency_number: null })).statusCode,
    ).toBe(200);
    const member = '01900000-0000-7000-8000-0000000001c1';
    expect(
      (await post(`/v1/org/clinicians/${member}`, { role: 'clinician', active: false })).statusCode,
    ).toBe(200);
    expect(new URL(seen[seen.length - 1]?.url ?? 'http://x').pathname).toBe(
      `/v1/org/clinicians/${member}`,
    );
    const before = seen.length;
    expect(
      (await post('/v1/org/clinicians/nope', { role: 'clinician', active: false })).statusCode,
    ).toBe(404);
    expect(seen).toHaveLength(before);
  });

  it('makes, lists and stops staff invitations; a stop answers 204 with no body', async () => {
    const { app, seen, active, activeCsrf } = await setup((req) =>
      new URL(req.url).pathname.endsWith('/revoke')
        ? new Response(null, { status: 204 })
        : json(201, { id: 'i', token: 'T'.repeat(43) }),
    );
    const post = (url: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          cookie: active,
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': activeCsrf,
          'idempotency-key': '0190a000-0000-4000-8000-000000000004',
        },
        payload: { role: 'clinician' },
      });
    expect((await post('/v1/org/staff-invitations')).statusCode).toBe(201);
    expect(
      (await app.inject({ url: '/v1/org/staff-invitations', headers: { cookie: active } }))
        .statusCode,
    ).toBe(201);
    const id = '01900000-0000-7000-8000-0000000001d1';
    const stop = await post(`/v1/org/staff-invitations/${id}/revoke`);
    expect(stop.statusCode).toBe(204);
    expect(stop.body).toBe('');
    const before = seen.length;
    expect((await post('/v1/org/staff-invitations/nope/revoke')).statusCode).toBe(404);
    expect(seen).toHaveLength(before);
  });
});

describe('REQ-011 the dashboard of the session organisation', () => {
  it('asks the API for the active organisation, never one the browser names', async () => {
    const { app, seen, active } = await setup(() => json(200, { months: [] }));
    expect(
      (await app.inject({ url: '/v1/dashboard', headers: { cookie: active } })).statusCode,
    ).toBe(200);
    expect(new URL(seen[seen.length - 1]?.url ?? 'http://x').pathname).toMatch(
      /^\/v1\/orgs\/[0-9a-f-]{36}\/dashboard$/,
    );
  });
});
