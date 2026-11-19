import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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

async function setup(
  api: (req: Request) => Response | Promise<Response>,
  confirmsPerMinute = 10,
  smartIssuers?: { iss: string; clientId: string; endpointOrigins?: string[] }[],
  smartMaxPending?: number,
) {
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
    ...(smartIssuers ? { smartIssuers } : {}),
    ...(smartMaxPending ? { smartMaxPending } : {}),
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

describe('M7 SMART App Launch (spec 16.2)', () => {
  const ISS = 'https://ehr.test/fhir';
  const EHR_PATIENT = 'ehr-patient-42';
  const PATIENT = '01900000-0000-7000-8000-0000000000a1';
  const LINK = createHash('sha256').update(`${ISS}|${EHR_PATIENT}`).digest('hex');
  let linked: string | null = null;
  const ehrAndApi = async (req: Request) => {
    const url = new URL(req.url);
    if (url.href === `${ISS}/.well-known/smart-configuration`)
      return json(200, {
        authorization_endpoint: 'https://ehr.test/authorize',
        token_endpoint: 'https://ehr.test/token',
      });
    if (url.href === 'https://ehr.test/token') {
      const form = new URLSearchParams(await req.text());
      if (form.get('code') !== 'code-1' || !form.get('code_verifier')) return json(400, {});
      return json(200, { access_token: 'ehr-token', token_type: 'Bearer', patient: EHR_PATIENT });
    }
    if (url.pathname === '/v1/ehr-links/resolve')
      return linked ? json(200, { patient_id: linked }) : json(404, {});
    if (url.pathname === `/v1/patients/${PATIENT}/ehr-links`) {
      const b = (await req.json()) as { link_hash: string };
      if (b.link_hash !== LINK) return json(400, {});
      if (linked) return json(409, {});
      linked = PATIENT;
      return json(201, { patient_id: PATIENT });
    }
    return json(404, {});
  };

  it('completes the launch server-side, keeps only a hash, and lets the clinician link once', async () => {
    linked = null;
    const { app, seen, active, activeCsrf } = await setup(ehrAndApi, 10, [
      { iss: ISS, clientId: 'endo-client' },
    ]);
    const start = await app.inject({
      url: `/smart/launch?iss=${encodeURIComponent(ISS)}&launch=L1`,
    });
    expect(start.statusCode).toBe(302);
    const to = new URL(String(start.headers.location));
    expect(to.origin + to.pathname).toBe('https://ehr.test/authorize');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('aud')).toBe(ISS);
    expect(to.searchParams.get('launch')).toBe('L1');
    const state = to.searchParams.get('state') ?? '';
    const binding = String(start.headers['set-cookie']).split(';')[0] ?? '';
    // Another browser (no binding cookie) cannot complete it.
    expect(
      (await app.inject({ url: `/smart/callback?code=code-1&state=${state}` })).statusCode,
    ).toBe(400);
    const again = await app.inject({
      url: `/smart/launch?iss=${encodeURIComponent(ISS)}&launch=L1`,
    });
    const state2 = new URL(String(again.headers.location)).searchParams.get('state') ?? '';
    const browser = String(again.headers['set-cookie']).split(';')[0] ?? binding;
    const back = await app.inject({
      url: `/smart/callback?code=code-1&state=${state2}`,
      headers: { cookie: browser },
    });
    expect(back.statusCode).toBe(200);
    const handle = /#launch=([A-Za-z0-9_-]{43})/.exec(back.body)?.[1] ?? '';
    expect(handle).not.toBe('');
    expect(back.body).not.toContain(EHR_PATIENT);
    expect(back.body).not.toContain('ehr-token');
    // The clinician's own session, in the browser that completed the launch.
    const post = (url: string, payload: object, cookie = `${active}; ${browser}`) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin: ORIGIN, 'x-csrf-token': activeCsrf },
        payload,
      });
    // A handle sent to another browser (Codex r8: launch injection) is useless there.
    expect((await post('/v1/smart/context', { handle }, active)).statusCode).toBe(404);
    expect((await post('/v1/smart/link', { handle, patient_id: PATIENT }, active)).statusCode).toBe(
      404,
    );
    expect((await post('/v1/smart/context', { handle })).json()).toEqual({ linked: false });
    expect((await post('/v1/smart/link', { handle, patient_id: PATIENT })).statusCode).toBe(201);
    // Used: the same handle cannot link again.
    expect((await post('/v1/smart/link', { handle, patient_id: PATIENT })).statusCode).toBe(404);
    // A new launch of the same record finds the link; linking it again is refused.
    const third = await app.inject({
      url: `/smart/launch?iss=${encodeURIComponent(ISS)}&launch=L2`,
      headers: { cookie: browser },
    });
    const state3 = new URL(String(third.headers.location)).searchParams.get('state') ?? '';
    const back3 = await app.inject({
      url: `/smart/callback?code=code-1&state=${state3}`,
      headers: { cookie: browser },
    });
    const handle3 = /#launch=([A-Za-z0-9_-]{43})/.exec(back3.body)?.[1] ?? '';
    expect((await post('/v1/smart/context', { handle: handle3 })).json()).toEqual({
      linked: true,
      patient_id: PATIENT,
    });
    expect(
      (await post('/v1/smart/link', { handle: handle3, patient_id: PATIENT })).statusCode,
    ).toBe(409);
    expect((await post('/v1/smart/context', { handle: 'x'.repeat(43) })).statusCode).toBe(404);
    // Only the hash ever reached the API.
    expect(seen.some((r) => r.url.includes(EHR_PATIENT))).toBe(false);
  });

  it('refuses an issuer not on the list and a record system that misbehaves', async () => {
    const { app } = await setup(ehrAndApi, 10, [{ iss: ISS, clientId: 'endo-client' }]);
    expect(
      (await app.inject({ url: '/smart/launch?iss=https%3A%2F%2Fevil.test&launch=L' })).statusCode,
    ).toBe(400);
    const bad = await setup(() => json(500, {}), 10, [{ iss: ISS, clientId: 'endo-client' }]);
    expect(
      (await bad.app.inject({ url: `/smart/launch?iss=${encodeURIComponent(ISS)}&launch=L` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/smart/callback?error=access_denied&state=x' })).statusCode,
    ).toBe(400);
  });
});

describe('M7 SMART App Launch: what goes wrong', () => {
  const ISS = 'https://ehr.test/fhir';
  const launchAndReturn = async (
    app: Awaited<ReturnType<typeof setup>>['app'],
  ): Promise<{ status: number; body: string; cookie: string }> => {
    const start = await app.inject({
      url: `/smart/launch?iss=${encodeURIComponent(ISS)}&launch=L`,
    });
    if (start.statusCode !== 302) return { status: start.statusCode, body: start.body, cookie: '' };
    const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
    const cookie = String(start.headers['set-cookie']).split(';')[0] ?? '';
    const back = await app.inject({
      url: `/smart/callback?code=c&state=${state}`,
      headers: { cookie },
    });
    return { status: back.statusCode, body: back.body, cookie };
  };
  const discovery = (authorize: string, token = 'https://ehr.test/token') =>
    json(200, { authorization_endpoint: authorize, token_endpoint: token });

  it('refuses endpoints on a host the issuer was not configured with (SSRF, redirect)', async () => {
    const foreign = await setup(() => discovery('https://evil.test/authorize'), 10, [
      { iss: ISS, clientId: 'c' },
    ]);
    expect((await launchAndReturn(foreign.app)).status).toBe(400);
    const internalToken = await setup(
      () => discovery('https://ehr.test/authorize', 'https://10.0.0.5/token'),
      10,
      [{ iss: ISS, clientId: 'c' }],
    );
    expect((await launchAndReturn(internalToken.app)).status).toBe(400);
    const vendor = 'https://login.ehr-vendor.test';
    const listed = await setup(
      (req) =>
        req.url.endsWith('/token')
          ? json(200, { patient: 'p1' })
          : discovery(`${vendor}/authorize`, `${vendor}/token`),
      10,
      [{ iss: ISS, clientId: 'c', endpointOrigins: [vendor] }],
    );
    expect((await launchAndReturn(listed.app)).status).toBe(200);
  });

  it('refuses endpoints on another scheme or not URLs, and a token without a patient', async () => {
    const insecure = await setup(() => discovery('http://ehr.test/authorize'), 10, [
      { iss: ISS, clientId: 'c' },
    ]);
    expect((await launchAndReturn(insecure.app)).status).toBe(400);
    const garbage = await setup(() => discovery('not a url'), 10, [{ iss: ISS, clientId: 'c' }]);
    const unreachable = await setup(
      () => {
        throw new TypeError('network');
      },
      10,
      [{ iss: ISS, clientId: 'c' }],
    );
    expect((await launchAndReturn(unreachable.app)).status).toBe(400);
    expect((await launchAndReturn(garbage.app)).status).toBe(400);
    const noPatient = await setup(
      (req) =>
        req.url.endsWith('/token')
          ? json(200, { access_token: 't' })
          : discovery('https://ehr.test/authorize'),
      10,
      [{ iss: ISS, clientId: 'c' }],
    );
    expect((await launchAndReturn(noPatient.app)).status).toBe(400);
  });

  it('refuses new launches while too many are pending', async () => {
    const full = await setup(
      () => discovery('https://ehr.test/authorize'),
      10,
      [{ iss: ISS, clientId: 'c' }],
      1,
    );
    const url = `/smart/launch?iss=${encodeURIComponent(ISS)}&launch=L`;
    expect((await full.app.inject({ url })).statusCode).toBe(302);
    expect((await full.app.inject({ url })).statusCode).toBe(400);
  });

  it('answers 403 when the API refuses and 502 when it cannot be reached', async () => {
    let apiDown = false;
    const s = await setup(
      (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith('smart-configuration'))
          return discovery('https://ehr.test/authorize');
        if (url.href === 'https://ehr.test/token') return json(200, { patient: 'p1' });
        if (apiDown) throw new TypeError('network');
        return json(500, {});
      },
      10,
      [{ iss: ISS, clientId: 'c' }],
    );
    const launched = await launchAndReturn(s.app);
    const handle = /#launch=([A-Za-z0-9_-]{43})/.exec(launched.body)?.[1] ?? '';
    const post = (url: string, payload: object) =>
      s.app.inject({
        method: 'POST',
        url,
        headers: {
          cookie: `${s.active}; ${launched.cookie}`,
          origin: ORIGIN,
          'x-csrf-token': s.activeCsrf,
        },
        payload,
      });
    expect((await post('/v1/smart/context', { handle })).statusCode).toBe(403);
    expect(
      (await post('/v1/smart/link', { handle, patient_id: '01900000-0000-7000-8000-0000000000a1' }))
        .statusCode,
    ).toBe(403);
    apiDown = true;
    expect((await post('/v1/smart/context', { handle })).statusCode).toBe(502);
  });
});
