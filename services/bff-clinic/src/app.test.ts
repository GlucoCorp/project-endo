import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { buildClinicBff } from './app.ts';
import { TransactionStore, type OidcConfig } from './oidc.ts';
import type { Membership, Resolver } from './resolve.ts';
import { InMemoryClinicSessions, OIDC_COOKIE, SESSION_COOKIE } from './sessions.ts';

const ISSUER = 'https://kc.test/realms/endo-dev';
const CONFIG: OidcConfig = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
  tokenEndpoint: `${ISSUER}/protocol/openid-connect/token`,
  clientId: 'bff-clinician',
  clientSecret: 'test-secret',
  redirectUri: 'https://clinic.test/auth/callback',
  requiredAcr: '1',
};
const PERSON = '01900000-0000-7000-8000-0000000000e1';
const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const NOW = new Date('2026-11-09T12:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);

/** A stand-in OIDC provider: signs ID tokens with generated keys; the BFF verifies via JWKS. */
async function setup(
  opts: {
    memberships?: Membership[];
    person?: string | null;
    claims?: (nonce: string) => Record<string, unknown>;
    tokenStatus?: number;
  } = {},
) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  let lastExchange: URLSearchParams | null = null;
  let issueNonce = '';
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience((claims['aud'] as string | string[] | undefined) ?? 'bff-clinician')
      .setSubject('kc-subject-1')
      .setIssuedAt(nowS)
      .setExpirationTime(nowS + 300)
      .sign(privateKey);
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    lastExchange = new URLSearchParams(init?.body as string);
    if (opts.tokenStatus && opts.tokenStatus !== 200)
      return new Response('{}', { status: opts.tokenStatus });
    const claims = opts.claims?.(issueNonce) ?? {
      nonce: issueNonce,
      auth_time: nowS - 5,
      acr: '1',
      sid: 'kc-session-1',
    };
    return Response.json({ id_token: await sign(claims) });
  }) as typeof fetch;
  const resolver: Resolver = {
    person: (iss, sub) =>
      Promise.resolve(
        iss === ISSUER && sub === 'kc-subject-1'
          ? opts.person === undefined
            ? PERSON
            : opts.person
          : null,
      ),
    memberships: () => Promise.resolve(opts.memberships ?? [{ orgId: ORG_A, role: 'clinician' }]),
  };
  const sessions = new InMemoryClinicSessions('test', () => NOW.getTime());
  const app = await buildClinicBff({
    logLevel: 'info',
    oidc: CONFIG,
    keys: createLocalJWKSet({ keys: [jwk] }),
    transactions: new TransactionStore(() => NOW.getTime()),
    sessions,
    resolver,
    fetch: fetchStub,
    now: () => NOW,
  });

  /** Starts a login; returns the transaction cookie and the parameters sent to Keycloak. */
  const start = async () => {
    const res = await app.inject({ url: '/auth/login' });
    const location = new URL(String(res.headers.location));
    const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
    issueNonce = location.searchParams.get('nonce') ?? '';
    return { res, location, cookie, state: location.searchParams.get('state') ?? '' };
  };
  const callback = (query: string, cookie?: string) =>
    app.inject({ url: `/auth/callback?${query}`, headers: cookie ? { cookie } : {} });
  const exchanged = () => lastExchange;
  return { app, start, callback, exchanged, sessions };
}

const sessionFrom = (setCookie: string | string[] | undefined) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe('ADR-0019 clinician sign-in: OIDC transaction, callback and session', () => {
  it('starts with PKCE S256, state, nonce, a fresh-login prompt and a Lax transaction cookie', async () => {
    const { start } = await setup();
    const { res, location, cookie } = await start();
    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(CONFIG.authorizationEndpoint);
    const p = location.searchParams;
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('response_mode')).toBe('query');
    expect(p.get('prompt')).toBe('login');
    expect(p.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.startsWith(`${OIDC_COOKIE}=`)).toBe(true);
    expect(String(res.headers['set-cookie'])).toMatch(
      /Secure; HttpOnly; SameSite=Lax; Max-Age=600/,
    );
  });

  it('completes: verifies PKCE at the token endpoint and sets a fresh Strict session cookie', async () => {
    const { start, callback, exchanged, app } = await setup();
    const { cookie, state, location } = await start();
    const res = await callback(`code=c1&state=${state}`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http-equiv="refresh"');
    const verifier = exchanged()?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      location.searchParams.get('code_challenge'),
    );
    const session = sessionFrom(res.headers['set-cookie']);
    expect(session).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    // The session id is new, never the transaction id.
    expect(session?.split(';')[0]?.split('=')[1]).not.toBe(cookie.split('=')[1]);
    const me = await app.inject({
      url: '/v1/session',
      headers: { cookie: session?.split(';')[0] ?? '' },
    });
    expect(me.json()).toEqual({
      state: 'active',
      organisations: [{ org_id: ORG_A, role: 'clinician' }],
      active: { org_id: ORG_A, role: 'clinician' },
    });
  });

  it('waits for a choice when the clinician belongs to several organisations', async () => {
    const { start, callback, app } = await setup({
      memberships: [
        { orgId: ORG_A, role: 'clinician' },
        { orgId: ORG_B, role: 'org_admin' },
      ],
    });
    const { cookie, state } = await start();
    const res = await callback(`code=c1&state=${state}`, cookie);
    const me = await app.inject({
      url: '/v1/session',
      headers: { cookie: sessionFrom(res.headers['set-cookie'])?.split(';')[0] ?? '' },
    });
    expect(me.json()).toMatchObject({ state: 'pending-org', active: null });
  });

  it('RFC 9700: refuses a callback without the browser-bound transaction cookie (login CSRF)', async () => {
    const { start, callback } = await setup();
    const { state } = await start();
    const res = await callback(`code=c1&state=${state}`);
    expect(res.statusCode).toBe(401);
    expect(sessionFrom(res.headers['set-cookie'])).toBeUndefined();
  });

  it('refuses a wrong state, a replayed transaction, a provider error and another issuer', async () => {
    const { start, callback } = await setup();
    const a = await start();
    expect((await callback(`code=c1&state=wrong`, a.cookie)).statusCode).toBe(401);
    // The mismatch also discarded the transaction: the right state no longer works.
    expect((await callback(`code=c1&state=${a.state}`, a.cookie)).statusCode).toBe(401);
    const b = await start();
    expect((await callback(`code=c1&state=${b.state}`, b.cookie)).statusCode).toBe(200);
    expect((await callback(`code=c1&state=${b.state}`, b.cookie)).statusCode).toBe(401); // replay
    const c = await start();
    expect((await callback(`error=access_denied&state=${c.state}`, c.cookie)).statusCode).toBe(401);
    const d = await start();
    expect(
      (
        await callback(
          `code=c1&state=${d.state}&iss=${encodeURIComponent('https://evil.test')}`,
          d.cookie,
        )
      ).statusCode,
    ).toBe(401);
  });

  it.each([
    ['a wrong nonce', (n: string) => ({ nonce: `${n}x`, auth_time: nowS, acr: '1' })],
    ['a missing nonce', () => ({ auth_time: nowS, acr: '1' })],
    ['an SSO (not fresh) acr', (n: string) => ({ nonce: n, auth_time: nowS, acr: '0' })],
    ['a stale authentication', (n: string) => ({ nonce: n, auth_time: nowS - 3600, acr: '1' })],
    ['no auth_time', (n: string) => ({ nonce: n, acr: '1' })],
    [
      'an extra audience without azp',
      (n: string) => ({ nonce: n, auth_time: nowS, acr: '1', aud: ['bff-clinician', 'other'] }),
    ],
  ])('refuses an ID token with %s', async (_name, claims) => {
    const { start, callback } = await setup({ claims });
    const { cookie, state } = await start();
    expect((await callback(`code=c1&state=${state}`, cookie)).statusCode).toBe(401);
  });

  it('refuses an unknown person, a person with no active membership, and a failed code exchange', async () => {
    for (const opts of [{ person: null }, { memberships: [] }, { tokenStatus: 400 }]) {
      const { start, callback } = await setup(opts);
      const { cookie, state } = await start();
      const res = await callback(`code=c1&state=${state}`, cookie);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        type: 'https://errors.glucorp.health/authn.sign_in_failed',
      });
    }
  });

  it('requires a session for /v1/session and rejects unknown query parameters at login', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/v1/session' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/auth/login?next=https://evil.test' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });
});
