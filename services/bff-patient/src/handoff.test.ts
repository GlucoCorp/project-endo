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
