import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { buildClinicBff } from './app.ts';
import { SeenTokenIds, TransactionStore, type OidcConfig } from './oidc.ts';
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
  endSessionEndpoint: `${ISSUER}/protocol/openid-connect/logout`,
  postLogoutRedirectUri: 'https://clinic.test/',
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
    /** Answers for successive membership reads (overrides `memberships`). */
    membershipReads?: Membership[][];
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
    memberships: () =>
      Promise.resolve(
        opts.membershipReads?.shift() ?? opts.memberships ?? [{ orgId: ORG_A, role: 'clinician' }],
      ),
  };
  const sessions = new InMemoryClinicSessions('test', () => NOW.getTime());
  const app = await buildClinicBff({
    logLevel: 'info',
    oidc: CONFIG,
    keys: createLocalJWKSet({ keys: [jwk] }),
    transactions: new TransactionStore(() => NOW.getTime()),
    logoutTokens: new SeenTokenIds(() => NOW.getTime()),
    sessions,
    resolver,
    fetch: fetchStub,
    now: () => NOW,
    portalOrigin: 'https://clinic.test',
  });

  /** Starts a login; returns the transaction cookie and the parameters sent to Keycloak. */
  const start = async (browserCookie?: string) => {
    const res = await app.inject({
      url: '/auth/login',
      headers: browserCookie ? { cookie: browserCookie } : {},
    });
    const location = new URL(String(res.headers.location));
    const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
    issueNonce = location.searchParams.get('nonce') ?? '';
    return {
      res,
      location,
      cookie,
      state: location.searchParams.get('state') ?? '',
      nonce: issueNonce,
    };
  };
  const callback = (query: string, cookie?: string) =>
    app.inject({ url: `/auth/callback?${query}`, headers: cookie ? { cookie } : {} });
  const exchanged = () => lastExchange;
  /** Which login the stand-in Keycloak is answering (its token carries that login's nonce). */
  const answer = (nonce: string) => {
    issueNonce = nonce;
  };
  /** A back-channel logout token signed by the stand-in Keycloak. */
  const logoutToken = (claims: Record<string, unknown>, audience = 'bff-clinician') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'logout+jwt' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt(nowS)
      .setJti(String(Math.floor(nowS)) + JSON.stringify(claims).length.toString() + audience)
      .sign(privateKey);
  return { app, start, callback, exchanged, answer, sessions, logoutToken };
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
    expect(me.json()).toMatchObject({
      state: 'active',
      organisations: [{ index: 0, org_id: ORG_A, role: 'clinician' }],
      active: { org_id: ORG_A, role: 'clinician' },
    });
    expect(me.json<{ csrf_token: string }>().csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
    // A wrong state does not destroy the real attempt.
    expect((await callback(`code=c1&state=${a.state}`, a.cookie)).statusCode).toBe(200);
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

  it('two tabs in one browser can each complete their own sign-in', async () => {
    const { start, callback, answer } = await setup();
    const tabA = await start();
    const tabB = await start(tabA.cookie); // same browser: the binding cookie is reused
    expect(tabB.cookie).toBe(tabA.cookie);
    expect(tabA.state).not.toBe(tabB.state);
    answer(tabB.nonce);
    expect((await callback(`code=c1&state=${tabB.state}`, tabB.cookie)).statusCode).toBe(200);
    answer(tabA.nonce);
    expect((await callback(`code=c1&state=${tabA.state}`, tabA.cookie)).statusCode).toBe(200);
  });

  it('refuses a callback from another browser, and leaves the attempt for its owner', async () => {
    const { start, callback } = await setup();
    const mine = await start();
    const other = await start(); // a different browser gets a different binding
    expect(other.cookie).not.toBe(mine.cookie);
    expect((await callback(`code=c1&state=${mine.state}`, other.cookie)).statusCode).toBe(401);
  });

  it('activates a single organisation with its CURRENT role, re-read at activation', async () => {
    const { start, callback, app } = await setup({
      membershipReads: [
        [{ orgId: ORG_A, role: 'clinician' }],
        [{ orgId: ORG_A, role: 'org_admin' }],
      ],
    });
    const { cookie, state } = await start();
    const res = await callback(`code=c1&state=${state}`, cookie);
    const me = await app.inject({
      url: '/v1/session',
      headers: { cookie: sessionFrom(res.headers['set-cookie'])?.split(';')[0] ?? '' },
    });
    expect(me.json()).toMatchObject({ active: { org_id: ORG_A, role: 'org_admin' } });
  });

  it('refuses when the only membership is revoked between resolution and activation', async () => {
    const { start, callback } = await setup({
      membershipReads: [[{ orgId: ORG_A, role: 'clinician' }], []],
    });
    const { cookie, state } = await start();
    const res = await callback(`code=c1&state=${state}`, cookie);
    expect(res.statusCode).toBe(401);
    expect(sessionFrom(res.headers['set-cookie'])).toBeUndefined();
  });

  it.each([
    [
      'a mismatched azp',
      (n: string) => ({ nonce: n, auth_time: nowS, acr: '1', azp: 'another-client' }),
    ],
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

describe('ADR-0019 section 5 and 8: choosing an organisation, CSRF, rotation', () => {
  const ORIGIN = 'https://clinic.test';
  const cookieOf = (setCookie: string | string[] | undefined) =>
    sessionFrom(setCookie)?.split(';')[0] ?? '';

  /** Signs in a clinician with two organisations; returns the pending session cookie. */
  async function pending(membershipReads?: Membership[][]) {
    const two = [
      { orgId: ORG_A, role: 'clinician' as const },
      { orgId: ORG_B, role: 'org_admin' as const },
    ];
    const ctx = await setup({ memberships: two, ...(membershipReads ? { membershipReads } : {}) });
    const { cookie, state } = await ctx.start();
    const res = await ctx.callback(`code=c1&state=${state}`, cookie);
    const session = cookieOf(res.headers['set-cookie']);
    const csrf = (await ctx.app.inject({ url: '/v1/session', headers: { cookie: session } })).json<{
      csrf_token: string;
    }>().csrf_token;
    const choose = (
      index: number,
      opts: { cookie?: string; csrf?: string; origin?: string | null } = {},
    ) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/session/organisation',
        headers: {
          cookie: opts.cookie ?? session,
          'x-csrf-token': opts.csrf ?? csrf,
          ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
        },
        payload: { index },
      });
    return { ...ctx, session, csrf, choose };
  }

  it('a pending session may see its state but nothing that needs an organisation', async () => {
    const { app, session } = await pending();
    expect(
      (await app.inject({ url: '/v1/session', headers: { cookie: session } })).statusCode,
    ).toBe(200);
    const ctx = await app.inject({ url: '/v1/context', headers: { cookie: session } });
    expect(ctx.statusCode).toBe(403);
    expect(ctx.json()).toMatchObject({
      type: 'https://errors.glucorp.health/authz.organisation_required',
    });
  });

  it('choosing rotates the session id and CSRF token; the old id stops working', async () => {
    const { app, session, csrf, choose } = await pending();
    const res = await choose(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'active',
      active: { org_id: ORG_B, role: 'org_admin' },
    });
    const next = cookieOf(res.headers['set-cookie']);
    expect(next).not.toBe(session);
    expect(res.json<{ csrf_token: string }>().csrf_token).not.toBe(csrf);
    expect(
      (await app.inject({ url: '/v1/context', headers: { cookie: session } })).statusCode,
    ).toBe(401);
    const ctx = await app.inject({ url: '/v1/context', headers: { cookie: next } });
    expect(ctx.json()).toEqual({ org_id: ORG_B, role: 'org_admin' });
  });

  it('switching organisation rotates again, so a stale tab cannot act', async () => {
    const { app, choose } = await pending();
    const first = await choose(0);
    const firstCookie = cookieOf(first.headers['set-cookie']);
    const firstCsrf = first.json<{ csrf_token: string }>().csrf_token;
    const second = await choose(1, { cookie: firstCookie, csrf: firstCsrf });
    expect(second.statusCode).toBe(200);
    // The tab still holding the first session is out.
    expect((await choose(0, { cookie: firstCookie, csrf: firstCsrf })).statusCode).toBe(401);
    const ctx = await app.inject({
      url: '/v1/context',
      headers: { cookie: cookieOf(second.headers['set-cookie']) },
    });
    expect(ctx.json()).toEqual({ org_id: ORG_B, role: 'org_admin' });
  });

  it('uses the CURRENT role at choice time, and refuses a membership revoked since sign-in', async () => {
    const changed = await pending([
      [
        { orgId: ORG_A, role: 'clinician' },
        { orgId: ORG_B, role: 'org_admin' },
      ],
      [{ orgId: ORG_A, role: 'org_admin' }],
    ]);
    expect((await changed.choose(0)).json()).toMatchObject({ active: { role: 'org_admin' } });
    const revoked = await pending([
      [
        { orgId: ORG_A, role: 'clinician' },
        { orgId: ORG_B, role: 'org_admin' },
      ],
      [{ orgId: ORG_A, role: 'clinician' }],
    ]);
    expect((await revoked.choose(1)).statusCode).toBe(403);
  });

  it.each([
    ['no Origin', { origin: null }],
    ['a null Origin', { origin: 'null' }],
    ['another Origin', { origin: 'https://evil.test' }],
    ['a wrong CSRF token', { csrf: 'x'.repeat(43) }],
    ['an empty CSRF token', { csrf: '' }],
  ] as const)('CSRF: refuses %s', async (_n, opts) => {
    const { choose } = await pending();
    const res = await choose(0, opts);
    expect(res.statusCode).toBe(403);
  });

  it('can choose any listed organisation, however many (no arbitrary index cap)', async () => {
    const many = Array.from({ length: 101 }, (_v, i) => ({
      orgId: `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
      role: 'clinician' as const,
    }));
    const ctx = await setup({ memberships: many });
    const { cookie, state } = await ctx.start();
    const res = await ctx.callback(`code=c1&state=${state}`, cookie);
    const session = cookieOf(res.headers['set-cookie']);
    const csrf = (await ctx.app.inject({ url: '/v1/session', headers: { cookie: session } })).json<{
      csrf_token: string;
    }>().csrf_token;
    const chosen = await ctx.app.inject({
      method: 'POST',
      url: '/v1/session/organisation',
      headers: { cookie: session, 'x-csrf-token': csrf, origin: ORIGIN },
      payload: { index: 100 },
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toMatchObject({ active: { org_id: many[100]?.orgId } });
  });

  it('accepts only an index into the server-side list', async () => {
    const { app, session, csrf, choose } = await pending();
    expect((await choose(5)).statusCode).toBe(400);
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/session/organisation',
      headers: { cookie: session, 'x-csrf-token': csrf, origin: ORIGIN },
      payload: { index: 0, org_id: ORG_B, role: 'org_admin' },
    });
    expect(forged.statusCode).toBe(400);
  });
});

describe('ADR-0019 section 6: sign-out and back-channel logout', () => {
  const ORIGIN = 'https://clinic.test';
  const EVENT = { 'http://schemas.openid.net/event/backchannel-logout': {} };

  async function signedIn() {
    const ctx = await setup();
    const { cookie, state } = await ctx.start();
    const res = await ctx.callback(`code=c1&state=${state}`, cookie);
    const session = sessionFrom(res.headers['set-cookie'])?.split(';')[0] ?? '';
    const csrf = (await ctx.app.inject({ url: '/v1/session', headers: { cookie: session } })).json<{
      csrf_token: string;
    }>().csrf_token;
    const alive = async () =>
      (await ctx.app.inject({ url: '/v1/context', headers: { cookie: session } })).statusCode ===
      200;
    const backchannel = (token: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/auth/backchannel-logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ logout_token: token }).toString(),
      });
    return { ...ctx, session, csrf, alive, backchannel };
  }

  it('signs out: revokes locally, clears the cookie and returns the Keycloak logout URL', async () => {
    const { app, session, csrf, alive } = await signedIn();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: session, 'x-csrf-token': csrf, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    const url = new URL(res.json<{ logout_url: string }>().logout_url);
    expect(url.origin + url.pathname).toBe(CONFIG.endSessionEndpoint);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(CONFIG.postLogoutRedirectUri);
    expect(url.searchParams.get('id_token_hint')?.split('.')).toHaveLength(3);
    expect(await alive()).toBe(false);
  });

  it('refuses sign-out without the CSRF token (a cross-site page cannot sign her out)', async () => {
    const { app, session, alive } = await signedIn();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: session, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(await alive()).toBe(true);
  });

  it('a valid back-channel logout for her Keycloak session revokes it, once', async () => {
    const { backchannel, logoutToken, alive } = await signedIn();
    const token = await logoutToken({ events: EVENT, sid: 'kc-session-1' });
    expect((await backchannel(token)).statusCode).toBe(200);
    expect(await alive()).toBe(false);
    expect((await backchannel(token)).statusCode).toBe(400); // replayed jti
  });

  it('revokes by subject when the token has no sid, and is idempotent for unknown sessions', async () => {
    const { backchannel, logoutToken, alive } = await signedIn();
    expect((await backchannel(await logoutToken({ events: EVENT, sid: 'other' }))).statusCode).toBe(
      200,
    );
    expect(await alive()).toBe(true);
    expect(
      (await backchannel(await logoutToken({ events: EVENT, sub: 'kc-subject-1' }))).statusCode,
    ).toBe(200);
    expect(await alive()).toBe(false);
  });

  it.each([
    ['no logout event', { sid: 'kc-session-1' }, 'bff-clinician'],
    [
      'a nonce (an ID token, not a logout token)',
      { events: EVENT, sid: 'kc-session-1', nonce: 'n' },
      'bff-clinician',
    ],
    ['neither sid nor sub', { events: EVENT }, 'bff-clinician'],
    ['another audience', { events: EVENT, sid: 'kc-session-1' }, 'another-client'],
  ] as const)('refuses a logout token with %s', async (_n, claims, audience) => {
    const { backchannel, logoutToken, alive } = await signedIn();
    expect((await backchannel(await logoutToken(claims, audience))).statusCode).toBe(400);
    expect(await alive()).toBe(true);
  });

  it('refuses a forged token and a malformed body', async () => {
    const { backchannel, app, alive } = await signedIn();
    expect((await backchannel('a.b.c')).statusCode).toBe(400);
    const empty = await app.inject({
      method: 'POST',
      url: '/auth/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'other=1',
    });
    expect(empty.statusCode).toBe(400);
    expect(await alive()).toBe(true);
  });
});
