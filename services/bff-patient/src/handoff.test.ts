import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { uuidv7 } from '@endo/domain';
import { TransactionStore, type OidcConfig } from '@endo/oidc';
import { ServiceTokenSigner, WorkloadTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from './app.ts';
import { ENROLMENT_COOKIE } from './enrolment.ts';
import { DevSessionStore, SESSION_COOKIE } from './sessions.ts';

const ORIGIN = 'https://app.endo.test';
const ISSUER = 'https://kc.test/realms/endo';
const OIDC: OidcConfig = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/auth`,
  tokenEndpoint: `${ISSUER}/token`,
  clientId: 'bff-patient',
  clientSecret: 'secret',
  redirectUri: `${ORIGIN}/auth/enrolment/callback`,
  requiredAcr: '1',
  endSessionEndpoint: `${ISSUER}/logout`,
  postLogoutRedirectUri: `${ORIGIN}/`,
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }],
  });
  const nowS = () => Math.floor(Date.now() / 1000);
  const txId = uuidv7();
  const subject = uuidv7();
  const state = {
    status: 'confirmed',
    nonce: '',
    lastHandoff: null as Record<string, string> | null,
    patient: true,
    identityDown: false,
    emailCalls: [] as Record<string, string>[],
    keycloakDown: false,
    logouts: [] as { body: string; auth: string }[],
  };
  const calls: { path: string; body: Record<string, string> }[] = [];
  const view = () => ({
    transaction_id: txId,
    status: state.status,
    expired: false,
    state_deadline: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const sessions = new DevSessionStore('test');
  // Stand-ins: the identity service, and Keycloak's token endpoint (which signs an ID token for
  // the provisional user with the nonce of the attempt the handoff was bound to).
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === OIDC.endSessionEndpoint) {
      if (state.keycloakDown) throw new TypeError('down');
      const headers = new Headers(init?.headers);
      state.logouts.push({
        body: init?.body as string,
        auth: headers.get('authorization') ?? '',
      });
      return new Response(null, { status: 204 });
    }
    if (url.href === OIDC.tokenEndpoint) {
      const idToken = await new SignJWT({ nonce: state.nonce, auth_time: nowS() - 2, acr: '1' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience('bff-patient')
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { id_token: idToken, refresh_token: 'rt' });
    }
    const body = JSON.parse(init?.body as string) as Record<string, string>;
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/internal/v1/email-codes/confirm') {
      state.emailCalls.push(body);
      return json(202, { request_id: EMAIL_REQUEST });
    }
    if (url.pathname === '/internal/v1/email-codes/confirm/verify') {
      state.emailCalls.push(body);
      return body['code'] === '123456' ? new Response(null, { status: 204 }) : json(403, {});
    }
    if (url.pathname === '/internal/v1/patients/resolve') {
      if (state.identityDown) throw new TypeError('down');
      return body['idp_subject'] === subject && body['idp_issuer'] === ISSUER && state.patient
        ? json(200, { person_id: PERSON, patient_id: PATIENT, org_id: ORG })
        : json(404, {});
    }
    if (url.pathname.endsWith('/handoff')) {
      if (state.status !== 'confirmed') return json(409, {});
      state.nonce = body['nonce'] ?? '';
      state.lastHandoff = body;
      return json(201, { handoff_ref: 'R'.repeat(43), expires_at: new Date().toISOString() });
    }
    if (url.pathname.endsWith('/consent')) {
      if (state.status !== 'consent-pending') return json(409, {});
      state.status = 'claiming';
      const later = new Date(Date.now() + 3_600_000).toISOString();
      return json(200, {
        transaction_id: txId,
        status: 'claiming',
        expired: false,
        state_deadline: null,
        expires_at: later,
      });
    }
    if (url.pathname.endsWith('/callback')) {
      if (body['subject'] !== subject) return json(403, {});
      state.status = 'consent-pending';
      return json(200, { ...view(), status: 'consent-pending' });
    }
    if (url.pathname.endsWith('/status')) {
      return json(200, {
        ...view(),
        ...(state.status === 'active'
          ? { account: { person_id: PERSON, patient_id: PATIENT, org_id: ORG, subject } }
          : {}),
      });
    }
    return json(404, {});
  }) as typeof fetch;
  const service = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const logs: string[] = [];
  const app = await buildBff({
    logLevel: 'info',
    sessions,
    signer: new ServiceTokenSigner(service.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: fetchImpl,
    logStream: { write: (m: string) => logs.push(m) },
    enrolment: {
      identityBaseUrl: 'http://identity.internal',
      signer: new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
      patientOrigin: ORIGIN,
      fetch: fetchImpl,
      now: () => new Date(),
      handoff: { oidc: OIDC, keys: jwks, transactions: new TransactionStore(), sessions },
    },
  });
  const secret = randomBytes(32).toString('base64url');
  const cookie = `${ENROLMENT_COOKIE}=${txId}${secret}`;
  const continueReq = (headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/enrolment/continue',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie, ...headers },
      payload: '{}',
    });
  /** Continue, then Keycloak's callback: returns the session cookie the callback set. */
  const signIn = async () => {
    const location = new URL((await continueReq()).json<{ location: string }>().location);
    const res = await app.inject({
      url: `/auth/enrolment/callback?code=c1&state=${location.searchParams.get('state') ?? ''}`,
      headers: { cookie },
    });
    return { res, session: sessionFrom(res.headers['set-cookie']) };
  };
  return { app, calls, state, secret, cookie, txId, continueReq, logs, signIn, sessions };
}

const PERSON = '01900000-0000-7000-8000-0000000000e1';
const EMAIL_REQUEST = '01900000-0000-7000-8000-0000000000e9';
const PATIENT = '01900000-0000-7000-8000-0000000000e2';
const ORG = '01900000-0000-7000-8000-0000000000e3';

/** The session token from Set-Cookie headers, or null (cleared or absent). */
function sessionFrom(header: string | string[] | undefined): string | null {
  const all = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const m = all.map((c) => /^__Host-endo_session=([^;]*)/.exec(c)).find((x) => x !== null);
  return m?.[1] ? m[1] : null;
}

describe('REQ-001 ADR-0021 sections 5 and 7: Continue into Keycloak, and back', () => {
  it('binds a handoff to its own OIDC attempt and sends only the reference to Keycloak', async () => {
    const { continueReq, calls, state, secret, txId } = await setup();
    const res = await continueReq();
    expect(res.statusCode).toBe(200);
    const location = new URL(res.json<{ location: string }>().location);
    expect(location.origin + location.pathname).toBe(OIDC.authorizationEndpoint);
    expect(location.searchParams.get('endo_handoff')).toBe('R'.repeat(43));
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    // The handoff names exactly this request.
    expect(calls[0]?.path).toBe(`/internal/v1/enrolment/transactions/${txId}/handoff`);
    expect(state.lastHandoff).toEqual({
      binding_hash: sha256(secret),
      kind: 'enrol',
      issuer: ISSUER,
      client_id: 'bff-patient',
      redirect_uri: OIDC.redirectUri,
      code_challenge: location.searchParams.get('code_challenge'),
      state: location.searchParams.get('state'),
      nonce: location.searchParams.get('nonce'),
    });
    // Nothing that binds her browser travels in the URL.
    expect(location.href).not.toContain(secret);
  });

  it('completes the callback for this browser only, then returns her to her page', async () => {
    const { app, continueReq, cookie, state, logs } = await setup();
    const location = new URL((await continueReq()).json<{ location: string }>().location);
    const s = location.searchParams.get('state') ?? '';
    // Another browser (no cookie) cannot use the callback.
    const stranger = await app.inject({ url: `/auth/enrolment/callback?code=c1&state=${s}` });
    expect(stranger.statusCode).toBe(303);
    expect(state.status).toBe('confirmed');
    const res = await app.inject({
      url: `/auth/enrolment/callback?code=c1&state=${s}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/enrol');
    expect(state.status).toBe('consent-pending');
    // ADR-0021 section 12: a fresh consent-pending session, Strict, never readable by script.
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/^__Host-endo_session=[A-Za-z0-9_-]{43}; /);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(stranger.headers['set-cookie']).toBeUndefined();
    // The attempt was used up.
    const again = await app.inject({
      url: `/auth/enrolment/callback?code=c1&state=${s}`,
      headers: { cookie },
    });
    expect(again.headers.location).toBe('/enrol');
    expect(logs.join('')).toContain('enrolment.callback_failed');
  });

  it('refuses Continue before confirmation, cross-site, or without the cookie', async () => {
    const { continueReq, state } = await setup();
    state.status = 'awaiting-confirmation';
    expect((await continueReq()).statusCode).toBe(409);
    expect((await continueReq({ origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await continueReq({ cookie: '' })).statusCode).toBe(404);
  });

  it('passes her four decisions on, with the browser binding, then shows where she is', async () => {
    const { app, calls, cookie, secret, txId, signIn } = await setup();
    const { session } = await signIn();
    const at = new Date().toISOString();
    const decisions = {
      self_tracking: { status: 'granted', version: 1, decided_at: at },
      share_with_care_team: { status: 'granted', version: 1, decided_at: at },
      research_deidentified: { status: 'declined', version: 1, decided_at: at },
      org_aggregate_reporting: { status: 'declined', version: 1, decided_at: at },
    };
    const send = (payload: object, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/enrolment/consent',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${cookie}; ${SESSION_COOKIE}=${session ?? ''}`,
          ...headers,
        },
        payload,
      });
    expect((await send({ decisions }, { origin: 'https://evil.test' })).statusCode).toBe(403);
    // Section 12: the enrolment cookie alone, or another session, cannot decide for her.
    expect((await send({ decisions }, { cookie })).statusCode).toBe(401);
    expect(
      (await send({ decisions }, { cookie: `${cookie}; ${SESSION_COOKIE}=${'x'.repeat(43)}` }))
        .statusCode,
    ).toBe(401);
    expect((await send({ decisions: { self_tracking: decisions.self_tracking } })).statusCode).toBe(
      400,
    );
    const res = await send({ decisions });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'claiming' });
    const sent = calls.find((c) => c.path.endsWith('/consent'));
    expect(sent?.path).toBe(`/internal/v1/enrolment/transactions/${txId}/consent`);
    expect(sent?.body).toEqual({ binding_hash: sha256(secret), decisions });
    expect((await send({ decisions })).statusCode).toBe(409);
  });

  it('ADR-0021 s12 rotates the consent-pending session into a patient session once active', async () => {
    const { app, state, cookie, signIn, sessions } = await setup();
    const { session } = await signIn();
    expect(session).not.toBeNull();
    const both = `${cookie}; ${SESSION_COOKIE}=${session ?? ''}`;
    const status = () => app.inject({ url: '/v1/enrolment/status', headers: { cookie: both } });
    // A consent-pending session never counts as a patient session.
    expect(await sessions.resolve(session ?? '')).toBeNull();
    expect((await app.inject({ url: '/v1/hello', headers: { cookie: both } })).statusCode).toBe(
      401,
    );
    // Not active yet: nothing changes.
    state.status = 'activating';
    expect((await status()).headers['set-cookie']).toBeUndefined();

    state.status = 'active';
    const res = await status();
    expect(res.statusCode).toBe(200);
    // The browser learns only where she is, never her ids.
    expect(res.json()).toEqual({
      status: 'active',
      expired: false,
      state_deadline: null,
      expires_at: expect.any(String) as string,
    });
    const rotated = sessionFrom(res.headers['set-cookie']);
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(session);
    // The enrolment cookie has done its job.
    expect(String(res.headers['set-cookie'])).toContain(`${ENROLMENT_COOKIE}=; `);
    expect((await sessions.resolve(rotated ?? ''))?.claims).toEqual({
      sub: PERSON,
      role: 'patient',
      org_id: ORG,
      patient_id: PATIENT,
    });
    // The old token is gone; asking again cannot rotate twice.
    expect(await sessions.consentPending(session ?? '')).toBeNull();
    expect((await status()).headers['set-cookie']).toBeUndefined();
  });

  it('ADR-0021 s12 ends the consent-pending session when enrolment ends, and on sign-out', async () => {
    const { app, state, cookie, signIn, sessions } = await setup();
    const first = (await signIn()).session ?? '';
    state.status = 'cancelling';
    const res = await app.inject({
      url: '/v1/enrolment/status',
      headers: { cookie: `${cookie}; ${SESSION_COOKIE}=${first}` },
    });
    expect(sessionFrom(res.headers['set-cookie'])).toBeNull();
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await sessions.consentPending(first)).toBeNull();

    const token = await sessions.createConsentPending('01900000-0000-7000-8000-0000000000f9', 's');
    const signOut = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/v1/session/sign-out',
        headers: { 'content-type': 'application/json', ...headers },
        payload: '{}',
      });
    expect(
      (await signOut({ origin: 'https://evil.test', cookie: `${SESSION_COOKIE}=${token}` }))
        .statusCode,
    ).toBe(403);
    expect(await sessions.consentPending(token)).not.toBeNull();
    const out = await signOut({ origin: ORIGIN, cookie: `${SESSION_COOKIE}=${token}` });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await sessions.consentPending(token)).toBeNull();
  });

  it('RISK-S02 sign-out ends her Keycloak session too, from the server, after her own', async () => {
    const { app, state, signIn, sessions, logs } = await setup();
    const signOut = (session: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/session/sign-out',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${session}`,
        },
        payload: '{}',
      });
    const first = (await signIn()).session ?? '';
    const out = await signOut(first);
    expect(out.statusCode).toBe(204);
    expect(await sessions.consentPending(first)).toBeNull();
    // Keycloak's logout endpoint, with her refresh token and the BFF's client authentication.
    expect(state.logouts).toHaveLength(1);
    expect(state.logouts[0]?.body).toBe('refresh_token=rt');
    expect(state.logouts[0]?.auth).toMatch(/^Basic /);
    // Signing out again with the same cookie has nothing left to end.
    expect((await signOut(first)).statusCode).toBe(204);
    expect(state.logouts).toHaveLength(1);

    // Keycloak unreachable: she is still signed out here, and the token is never logged.
    state.keycloakDown = true;
    state.status = 'confirmed';
    const second = (await signIn()).session ?? '';
    const down = await signOut(second);
    expect(down.statusCode).toBe(204);
    expect(await sessions.consentPending(second)).toBeNull();
    expect(logs.join('\n')).toContain('sign_out.keycloak_not_ended');
    expect(logs.join('\n')).not.toContain('rt"');
  });

  it('refuses to rotate when the coordinator names a different user', async () => {
    const { app, state, cookie, signIn, sessions } = await setup();
    const { session } = await signIn();
    state.status = 'active';
    // A session for this transaction but another Keycloak user: never promoted.
    const other = await sessions.createConsentPending(
      (await sessions.consentPending(session ?? ''))?.transactionId ?? '',
      'someone-else',
    );
    const res = await app.inject({
      url: '/v1/enrolment/status',
      headers: { cookie: `${cookie}; ${SESSION_COOKIE}=${other}` },
    });
    expect(res.statusCode).toBe(502);
    expect(await sessions.consentPending(other)).not.toBeNull();
  });
});

describe('REQ-001 spec 10.1: a returning patient signs in with her passkey', () => {
  /** /auth/sign-in, then Keycloak's return to /auth/callback with this attempt's state. */
  async function signInFlow(
    s: Awaited<ReturnType<typeof setup>>,
    cookieOverride?: string,
    session?: string,
  ) {
    const start = await s.app.inject({ url: '/auth/sign-in' });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location ?? '');
    s.state.nonce = location.searchParams.get('nonce') ?? '';
    const binding = /^__Host-endo_signin=([^;]+)/.exec(String(start.headers['set-cookie']))?.[1];
    const back = await s.app.inject({
      url: `/auth/callback?code=c2&state=${location.searchParams.get('state') ?? ''}`,
      headers: {
        cookie:
          (cookieOverride ?? `__Host-endo_signin=${binding ?? ''}`) +
          (session ? `; ${SESSION_COOKIE}=${session}` : ''),
      },
    });
    return { start, location, back };
  }

  it('signs her in to a fresh patient session through Keycloak, with PKCE and its own callback', async () => {
    const s = await setup();
    const { start, location, back } = await signInFlow(s);
    expect(location.origin + location.pathname).toBe(OIDC.authorizationEndpoint);
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.has('endo_handoff')).toBe(false);
    expect(String(start.headers['set-cookie'])).toMatch(
      /^__Host-endo_signin=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('url=/');
    const token = sessionFrom(back.headers['set-cookie']);
    expect(String(back.headers['set-cookie'])).toContain('SameSite=Strict');
    expect((await s.sessions.resolve(token ?? ''))?.claims).toEqual({
      sub: PERSON,
      role: 'patient',
      org_id: ORG,
      patient_id: PATIENT,
    });
    const resolveCall = s.calls.find((c) => c.path === '/internal/v1/patients/resolve');
    expect(resolveCall?.body).toEqual({
      idp_issuer: ISSUER,
      idp_subject: expect.any(String) as string,
    });
    // The page learns only that she is signed in.
    const me = await s.app.inject({
      url: '/v1/session',
      headers: { cookie: `${SESSION_COOKIE}=${token ?? ''}` },
    });
    expect(me.json()).toEqual({ signed_in: true, locked: false, app_lock: false });
    expect(me.body).not.toContain(PATIENT);
    expect((await s.app.inject({ url: '/v1/session' })).statusCode).toBe(401);
  });

  it('refuses the same way: another browser, a reused attempt, no patient record, identity down', async () => {
    const stranger = await setup();
    const a = await signInFlow(stranger, `__Host-endo_signin=${'x'.repeat(43)}`);
    expect(a.back.statusCode).toBe(401);
    expect(a.back.headers['set-cookie']).toBeUndefined();

    const notPatient = await setup();
    notPatient.state.patient = false;
    expect((await signInFlow(notPatient)).back.statusCode).toBe(401);

    const down = await setup();
    down.state.identityDown = true;
    const d = await signInFlow(down);
    expect(d.back.statusCode).toBe(401);
    expect(d.back.json<{ type: string }>().type).toBe(a.back.json<{ type: string }>().type);
    expect(down.logs.join('')).toContain('sign_in.failed');

    const errored = await setup();
    const start = await errored.app.inject({ url: '/auth/sign-in' });
    const st = new URL(start.headers.location ?? '').searchParams.get('state') ?? '';
    const binding = /^__Host-endo_signin=([^;]+)/.exec(String(start.headers['set-cookie']))?.[1];
    const res = await errored.app.inject({
      url: `/auth/callback?error=access_denied&state=${st}`,
      headers: { cookie: `__Host-endo_signin=${binding ?? ''}` },
    });
    expect(res.statusCode).toBe(401);
    // The attempt is used up even by a refusal.
    const again = await errored.app.inject({
      url: `/auth/callback?code=c2&state=${st}`,
      headers: { cookie: `__Host-endo_signin=${binding ?? ''}` },
    });
    expect(again.statusCode).toBe(401);
    expect((await errored.app.inject({ url: '/auth/sign-in?prompt=none' })).statusCode).toBe(400);
  });

  it('spec 10.1 unlocking is signing in again: her app-lock choice carries over, same person only', async () => {
    const s = await setup();
    const own = s.sessions.create({
      sub: PERSON,
      role: 'patient',
      org_id: ORG,
      patient_id: PATIENT,
    });
    await s.sessions.setAppLock(own, true);
    await s.sessions.lock(own);
    const start = await s.app.inject({ url: '/auth/sign-in' });
    const location = new URL(start.headers.location ?? '');
    s.state.nonce = location.searchParams.get('nonce') ?? '';
    const binding = /^__Host-endo_signin=([^;]+)/.exec(String(start.headers['set-cookie']))?.[1];
    const back = await s.app.inject({
      url: `/auth/callback?code=c2&state=${location.searchParams.get('state') ?? ''}`,
      headers: { cookie: `__Host-endo_signin=${binding ?? ''}; ${SESSION_COOKIE}=${own}` },
    });
    const fresh = sessionFrom(back.headers['set-cookie']) ?? '';
    expect(await s.sessions.resolve(own)).toBeNull();
    expect(await s.sessions.resolve(fresh)).toMatchObject({ locked: false, appLock: true });

    // Someone else's locked session on this phone: its choice is not hers.
    const other = s.sessions.create({
      sub: uuidv7(),
      role: 'patient',
      org_id: ORG,
      patient_id: uuidv7(),
    });
    await s.sessions.setAppLock(other, true);
    const again = await signInFlow(s, undefined, other);
    expect(
      await s.sessions.resolve(sessionFrom(again.back.headers['set-cookie']) ?? ''),
    ).toMatchObject({ appLock: false });
  });

  it('ADR-0026 she adds and confirms her email, for her own session only', async () => {
    const s = await setup();
    const own = s.sessions.create({
      sub: PERSON,
      role: 'patient',
      org_id: ORG,
      patient_id: PATIENT,
    });
    const send = (url: string, payload: object, headers: Record<string, string> = {}) =>
      s.app.inject({
        method: 'POST',
        url,
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${own}`,
          ...headers,
        },
        payload,
      });
    const address = 'SYNTHETIC_PHI_MARKER@example.test';
    const started = await send('/v1/settings/email', { address });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ request_id: EMAIL_REQUEST });
    // The person comes from her session, never from the request.
    expect(s.state.emailCalls[0]).toMatchObject({ person_id: PERSON, address });
    expect((await send('/v1/settings/email', { address, person_id: 'x' })).statusCode).toBe(400);

    const wrong = await send('/v1/settings/email/confirm', {
      request_id: EMAIL_REQUEST,
      code: '000000',
    });
    expect(wrong.statusCode).toBe(400);
    expect(
      (await send('/v1/settings/email/confirm', { request_id: EMAIL_REQUEST, code: '123456' }))
        .statusCode,
    ).toBe(204);
    expect(s.state.emailCalls.at(-1)).toEqual({
      person_id: PERSON,
      request_id: EMAIL_REQUEST,
      code: '123456',
    });

    // Not signed in, locked, cross-site, or not JSON: refused before identity is asked.
    const before = s.state.emailCalls.length;
    expect((await send('/v1/settings/email', { address }, { cookie: '' })).statusCode).toBe(401);
    expect(
      (await send('/v1/settings/email', { address }, { origin: 'https://evil.test' })).statusCode,
    ).toBe(403);
    expect(
      (await send('/v1/settings/email', { address }, { 'content-type': 'text/plain' })).statusCode,
    ).toBe(415);
    await s.sessions.setAppLock(own, true);
    await s.sessions.lock(own);
    expect((await send('/v1/settings/email', { address })).statusCode).toBe(401);
    expect(s.state.emailCalls.length).toBe(before);
    expect(s.logs.join('')).not.toContain('SYNTHETIC_PHI_MARKER');
  });
});
