import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet } from 'jose';
import { expect, test } from '@playwright/test';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import { ServiceTokenSigner, generateServiceKeyPair, loadAppShell } from '@endo/service-kit';
import { buildClinicBff } from '@endo/bff-clinic/app';
import { SeenTokenIds, TransactionStore } from '@endo/bff-clinic/oidc';
import { InMemoryClinicSessions, SESSION_COOKIE } from '@endo/bff-clinic/sessions';

/**
 * ADR-0021 slice 3 in a real browser: the real clinic BFF serves the built portal (CSP with a
 * per-response nonce, Trusted Types) and its enrolment routes. Sign-in itself is covered by the
 * clinic BFF's own browser test (ADR-0019 7a); here the session is created directly. The API is a
 * stand-in that knows one invitation and its code.
 */
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const ORG = '01900000-0000-7000-8000-00000000000a';
const INVITATION = '01900000-0000-7000-8000-0000000000d1';
const CODE = '482916';
let wrongLeft = 5;
let confirmed = false;

function api(path: string, body: Record<string, unknown> | null): Response {
  const reply = (b: unknown) =>
    new Response(JSON.stringify(b), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (path === '/v1/enrolments')
    return reply({
      invitations: confirmed
        ? []
        : [
            {
              id: INVITATION,
              created_at: '2026-11-11T08:00:00Z',
              expires_at: '2026-11-18T08:00:00Z',
              in_use: false,
            },
          ],
    });
  if (path === `/v1/enrolments/${INVITATION}/confirm`) {
    if (body?.['code'] === CODE) {
      confirmed = true;
      return reply({ outcome: 'confirmed' });
    }
    wrongLeft -= 1;
    return reply({ outcome: 'wrong', remaining: wrongLeft });
  }
  return new Response('{}', { status: 404 });
}

let bff: Awaited<ReturnType<typeof buildClinicBff>>;
let origin = '';
let sessionCookie = '';
const violations: string[] = [];

test.beforeAll(async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, 'localhost', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => {
        resolve(p);
      });
    });
  });
  origin = `http://localhost:${String(port)}`;
  const keys = await generateServiceKeyPair();
  const sessions = new InMemoryClinicSessions('test');
  const issuer = 'https://kc.test/realms/endo';
  bff = await buildClinicBff({
    logLevel: 'silent',
    oidc: {
      issuer,
      authorizationEndpoint: `${issuer}/auth`,
      tokenEndpoint: `${issuer}/token`,
      clientId: 'bff-clinician',
      clientSecret: 'test-secret',
      redirectUri: `${origin}/auth/callback`,
      requiredAcr: '1',
      endSessionEndpoint: `${issuer}/logout`,
      postLogoutRedirectUri: `${origin}/`,
    },
    keys: createLocalJWKSet({ keys: [] }),
    transactions: new TransactionStore(),
    logoutTokens: new SeenTokenIds(),
    sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/identity'),
    sessions,
    resolver: {
      person: () => Promise.resolve(null),
      memberships: () => Promise.resolve([{ orgId: ORG, role: 'clinician' as const }]),
    },
    fetch: () => Promise.reject(new Error('unused')),
    now: () => new Date(),
    portalOrigin: origin,
    appShell: loadAppShell(DIST),
    enrolment: {
      apiBaseUrl: 'http://api.invalid',
      signer: new ServiceTokenSigner(keys.privateJwk, 'bff-clinic'),
      fetch: async (input, init) => {
        const r = new Request(input, init);
        const body = r.method === 'POST' ? ((await r.json()) as Record<string, unknown>) : null;
        return api(new URL(r.url).pathname, body);
      },
      now: () => new Date(),
    },
  });
  await bff.listen({ host: 'localhost', port });
  sessionCookie = await sessions.create({
    personId: '01900000-0000-7000-8000-0000000000e1',
    issuer,
    subject: 'kc-1',
    sid: null,
    idToken: 'id',
    refresh: await new EnvelopeSealer(new DevKeyManager('test'), 'kms/identity').seal('rt', 'ctx'),
    memberships: [{ orgId: ORG, role: 'clinician' }],
  });
});

test.afterAll(() => bff.close());

test('the clinician chooses the organisation and confirms the patient by code', async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: sessionCookie,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  page.on('console', (m) => {
    if (/Content Security Policy|Trusted Type/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: /as clinician/ }).click();
  await expect(page.getByRole('heading', { name: 'Confirm a patient' })).toBeVisible();

  const confirm = page.getByRole('button', { name: 'Confirm' });
  await expect(confirm).toBeDisabled();
  await page.getByRole('radio').check();
  await page.getByLabel('Code from her phone').fill('111111');
  // Without both statements, nothing is sent.
  await confirm.click();
  await expect(page.getByText('Both statements must be true to confirm.')).toBeVisible();
  await page.getByLabel('I have identified her').check();
  await page.getByLabel('I read the code from her own phone.').check();
  await confirm.click();
  await expect(page.getByText('That code does not match. 4 more tries')).toBeVisible();

  await page.getByLabel('Code from her phone').fill(CODE);
  await confirm.click();
  await expect(
    page.getByText('Confirmed. She can now create her sign-in on her phone.'),
  ).toBeVisible();
  await expect(page.getByText('There are no open invitations.')).toBeVisible();
  expect(violations).toEqual([]);
});

test('signed out, the portal offers sign-in', async ({ page }) => {
  await page.goto(`${origin}/`);
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login');
});
