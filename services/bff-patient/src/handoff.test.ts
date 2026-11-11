import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { uuidv7 } from '@endo/domain';
import { TransactionStore, type OidcConfig } from '@endo/oidc';
import { ServiceTokenSigner, WorkloadTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from './app.ts';
import { ENROLMENT_COOKIE } from './enrolment.ts';
import { DevSessionStore } from './sessions.ts';

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
    if (url.pathname.endsWith('/callback')) {
      if (body['subject'] !== subject) return json(403, {});
      state.status = 'consent-pending';
      return json(200, {});
    }
    return json(404, {});
  }) as typeof fetch;
  const service = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const logs: string[] = [];
  const app = await buildBff({
    logLevel: 'info',
    sessions: new DevSessionStore('test'),
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
      handoff: { oidc: OIDC, keys: jwks, transactions: new TransactionStore() },
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
  return { app, calls, state, secret, cookie, txId, continueReq, logs };
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
});
