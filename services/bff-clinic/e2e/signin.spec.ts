import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import { buildClinicBff } from '../src/app.ts';
import { SeenTokenIds, TransactionStore } from '../src/oidc.ts';
import { InMemoryClinicSessions } from '../src/sessions.ts';

/**
 * ADR-0019 slice 7a: a real browser completes clinician sign-in. The portal runs on `localhost`
 * and the stand-in identity provider on `127.0.0.1`, which browsers treat as different sites, so
 * the callback really is a cross-site navigation and SameSite rules really apply.
 */
const ORG = '01900000-0000-7000-8000-00000000000a';
const PERSON = '01900000-0000-7000-8000-0000000000e1';

let idp: Server;
let bff: Awaited<ReturnType<typeof buildClinicBff>>;
let portal = '';

test.beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const pending = new Map<string, { nonce: string; redirect: string }>();
  let issuer = '';

  // A minimal provider: /auth redirects straight back (the user "signed in"); /token issues tokens.
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/auth') {
      const code = `code-${String(pending.size)}`;
      pending.set(code, {
        nonce: url.searchParams.get('nonce') ?? '',
        redirect: url.searchParams.get('redirect_uri') ?? '',
      });
      const back = new URL(pending.get(code)?.redirect ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        const now = Math.floor(Date.now() / 1000);
        void new SignJWT({ nonce: pending.get(code)?.nonce, auth_time: now, acr: '1', sid: 's1' })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience('bff-clinician')
          .setSubject('kc-subject-1')
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey)
          .then((idToken) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id_token: idToken, refresh_token: 'rt-0' }));
          });
      });
      return;
    }
    if (url.pathname === '/elsewhere') {
      // A page on another site linking to the portal: a cross-site navigation.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<a id="go" href="${portal}/v1/session">portal</a>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${String((idp.address() as AddressInfo).port)}`;

  // Mutable on purpose: the callback URI needs the portal's port, known only after listen().
  // The BFF reads this object on every request.
  const oidc = {
    issuer,
    authorizationEndpoint: `${issuer}/auth`,
    tokenEndpoint: `${issuer}/token`,
    clientId: 'bff-clinician',
    clientSecret: 'browser-test-secret',
    redirectUri: '',
    requiredAcr: '1',
    endSessionEndpoint: `${issuer}/logout`,
    postLogoutRedirectUri: 'http://localhost/',
  };
  bff = await buildClinicBff({
    logLevel: 'error',
    oidc,
    keys: createLocalJWKSet({ keys: [jwk] }),
    transactions: new TransactionStore(),
    logoutTokens: new SeenTokenIds(),
    sessions: new InMemoryClinicSessions('test'),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/identity'),
    resolver: {
      person: () => Promise.resolve(PERSON),
      memberships: () => Promise.resolve([{ orgId: ORG, role: 'clinician' as const }]),
    },
    fetch,
    now: () => new Date(),
    portalOrigin: 'http://localhost',
  });
  await bff.listen({ host: '127.0.0.1', port: 0 });
  portal = `http://localhost:${String((bff.server.address() as AddressInfo).port)}`;
  oidc.redirectUri = `${portal}/auth/callback`;
});

test.afterAll(async () => {
  await bff.close();
  await new Promise<void>((r) => {
    idp.close(() => {
      r();
    });
  });
});

test('a real browser completes sign-in across sites and then sends the Strict session cookie', async ({
  page,
  context,
}) => {
  await page.goto(`${portal}/auth/login`);
  // After the cross-site callback, the same-origin completion page moves on to the portal.
  await page.waitForURL(`${portal}/`);
  const session = await page.goto(`${portal}/v1/session`);
  expect(session?.status()).toBe(200);
  expect(await session?.json()).toMatchObject({ state: 'active', active: { org_id: ORG } });

  const cookies = await context.cookies(portal);
  const sessionCookie = cookies.find((c) => c.name === '__Host-endo_clinic_session');
  expect(sessionCookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
  });
  expect(cookies.find((c) => c.name === '__Host-endo_clinic_oidc')?.sameSite).toBe('Lax');
});

test('the Strict session cookie is NOT sent on a navigation from another site', async ({
  page,
}) => {
  await page.goto(`${portal}/auth/login`);
  await page.waitForURL(`${portal}/`);
  // Arrive at the portal by clicking a link on a different site.
  await page.goto(
    `${new URL(portal).protocol}//127.0.0.1:${String((idp.address() as AddressInfo).port)}/elsewhere`,
  );
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url() === `${portal}/v1/session`),
    page.click('#go'),
  ]);
  expect(response.status()).toBe(401);
  // The same session still works when reached from the portal's own site, so the 401 above is
  // SameSite=Strict at work, not a lost session.
  const direct = await page.goto(`${portal}/v1/session`);
  expect(direct?.status()).toBe(200);
});
