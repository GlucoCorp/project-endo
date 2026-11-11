import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { uuidv7 } from '@endo/domain';
import { ServiceTokenSigner, WorkloadTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from '@endo/bff-patient/app';
import { DevSessionStore, SESSION_COOKIE } from '@endo/bff-patient/sessions';
import { TransactionStore } from '@endo/oidc';
import { loadAppShell } from '@endo/bff-patient/app-shell';

/**
 * ADR-0021 slice 2 in a real browser: the real patient BFF serves the built app (CSP with a
 * per-response nonce and Trusted Types) and its enrolment routes on one origin. Only the identity
 * service is a stand-in, which lets the test act as the clinic and confirm.
 */
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Tx = { id: string; tokenHash: string; status: string };
const transactions = new Map<string, Tx>(); // by binding hash
const liveTokens = new Set<string>();
let lastConsent: Record<string, { status: string; version: number }> | null = null;
let bff: Awaited<ReturnType<typeof buildBff>>;
const sessions = new DevSessionStore('test');
let origin = '';
let violations: string[] = [];

function fakeIdentity(url: URL, body: Record<string, string>): Response {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const view = (t: Tx) => ({
    transaction_id: t.id,
    status: t.status,
    expired: false,
    state_deadline: later,
    expires_at: later,
  });
  const reply = (status: number, b: unknown) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/internal/v1/enrolment/transactions') {
    if (!liveTokens.has(body['token_hash'] ?? '')) return reply(404, {});
    const open = transactions.get(body['binding_hash'] ?? '');
    if (open && open.status !== 'cancelling') return reply(200, view(open));
    const tx = {
      id: uuidv7(),
      tokenHash: body['token_hash'] ?? '',
      status: 'awaiting-confirmation',
    };
    transactions.set(body['binding_hash'] ?? '', tx);
    return reply(201, { ...view(tx), code: String(100000 + transactions.size) });
  }
  const m = /\/transactions\/([^/]+)\/(status|cancel|consent)$/.exec(url.pathname);
  const tx = transactions.get(body['binding_hash'] ?? '');
  if (!m || !tx || tx.id !== m[1]) return reply(404, {});
  if (m[2] === 'cancel') tx.status = 'cancelling';
  if (m[2] === 'consent') {
    if (tx.status !== 'consent-pending') return reply(409, {});
    lastConsent = body['decisions'] as unknown as Record<
      string,
      { status: string; version: number }
    >;
    tx.status = lastConsent['self_tracking']?.status === 'declined' ? 'cancelling' : 'claiming';
  }
  // Once active, the coordinator names her account, for the BFF only (ADR-0021 section 12).
  const account =
    tx.status === 'active'
      ? { person_id: PERSON, patient_id: PATIENT, org_id: ORG, subject: 'provisional-subject' }
      : null;
  return reply(200, { ...view(tx), ...(account ? { account } : {}) });
}
const PERSON = '01900000-0000-7000-8000-0000000000e1';
const PATIENT = '01900000-0000-7000-8000-0000000000e2';
const ORG = '01900000-0000-7000-8000-0000000000e3';

test.beforeAll(async () => {
  const service = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
  const identityFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    Promise.resolve(
      fakeIdentity(input as URL, JSON.parse(init?.body as string) as Record<string, string>),
    )) as typeof fetch;
  // The BFF must know its exact origin (Origin checks), so take a free port first.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, 'localhost', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => {
        resolve(p);
      });
    });
  });
  origin = `http://localhost:${String(port)}`;
  bff = await buildBff({
    logLevel: 'silent',
    sessions,
    signer: new ServiceTokenSigner(service.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.invalid',
    fetch: () => Promise.reject(new Error('unused')),
    // The real app, served by the real BFF with its real headers.
    appShell: loadAppShell(DIST),
    enrolment: {
      identityBaseUrl: 'http://identity.invalid',
      signer: new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
      patientOrigin: origin,
      fetch: identityFetch,
      now: () => new Date(),
      // Keycloak itself is not part of this test (slice 8 drives it); the test signs her in by
      // giving the browser the consent-pending session the callback would have created.
      handoff: {
        oidc: {
          issuer: 'http://keycloak.invalid/realms/endo',
          authorizationEndpoint: 'http://keycloak.invalid/auth',
          tokenEndpoint: 'http://keycloak.invalid/token',
          clientId: 'bff-patient',
          clientSecret: 'unused',
          redirectUri: `${origin}/auth/enrolment/callback`,
          requiredAcr: '1',
          endSessionEndpoint: 'http://keycloak.invalid/logout',
          postLogoutRedirectUri: `${origin}/`,
        },
        keys: () => Promise.reject(new Error('unused')),
        transactions: new TransactionStore(),
        sessions,
      },
    },
  });
  await bff.listen({ host: 'localhost', port });
});

test.afterAll(() => bff.close());

test.beforeEach(({ page }) => {
  violations = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Trusted Type/i.test(m.text())) violations.push(m.text());
  });
});

function newLink() {
  const token = randomBytes(32).toString('base64url');
  liveTokens.add(sha256(token));
  return token;
}
const confirmByClinic = () => {
  for (const tx of transactions.values())
    if (tx.status === 'awaiting-confirmation') tx.status = 'confirmed';
};
const codeOf = (page: Page) => page.getByLabel('Your code');

test('she opens her link, starts, shows the code, and sees the clinic confirm', async ({
  page,
}) => {
  transactions.clear();
  await page.goto(`${origin}/enrol#${newLink()}`);
  // The token leaves the address bar at once.
  await expect(page).toHaveURL(`${origin}/enrol`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(codeOf(page)).toHaveText(/^[0-9]{6}$/);
  const code = await codeOf(page).textContent();

  // A reload keeps the code (this tab's session storage) and the transaction (the cookie).
  await page.reload();
  await expect(codeOf(page)).toHaveText(code ?? '');

  confirmByClinic();
  await expect(page.getByText('The clinic has confirmed it is you.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(codeOf(page)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(violations).toEqual([]);
});

test('two tabs starting together share one transaction (Web Locks)', async ({ context }) => {
  transactions.clear();
  const link = newLink();
  const [a, b] = [await context.newPage(), await context.newPage()];
  await Promise.all([a.goto(`${origin}/enrol#${link}`), b.goto(`${origin}/enrol#${link}`)]);
  await Promise.all([
    a.getByRole('button', { name: 'Start' }).click(),
    b.getByRole('button', { name: 'Start' }).click(),
  ]);
  await expect(a.getByText(/Show this code|shown in another tab/)).toBeVisible();
  await expect(b.getByText(/Show this code|shown in another tab/)).toBeVisible();
  // Exactly one transaction, and exactly one tab shows its code.
  expect(transactions.size).toBe(1);
  const shown = (await codeOf(a).count()) + (await codeOf(b).count());
  expect(shown).toBe(1);
});

test('she can stop, and a used-up or wrong link says what to do', async ({ page }) => {
  transactions.clear();
  await page.goto(`${origin}/enrol#${newLink()}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(codeOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'Stop setting up' }).click();
  await expect(page.getByText('Setting up was stopped.')).toBeVisible();

  await page.goto(`${origin}/enrol#${randomBytes(32).toString('base64url')}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(
    page.getByText('This link cannot be used. Ask your clinic for a new one.'),
  ).toBeVisible();

  await page.goto(`${origin}/enrol`);
  await expect(page.getByText('Open the link your clinic gave you')).toBeVisible();
  expect(violations).toEqual([]);
});

test('after her passkey, she makes four separate choices; nothing is chosen for her', async ({
  page,
  context,
}) => {
  transactions.clear();
  await page.goto(`${origin}/enrol#${newLink()}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(codeOf(page)).toBeVisible();
  // Passkey created and called back (slice 8 drives the real Keycloak for this part).
  for (const tx of transactions.values()) {
    tx.status = 'consent-pending';
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: await sessions.createConsentPending(tx.id, 'provisional-subject'),
        domain: 'localhost',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
  }
  await page.reload();
  await expect(page.getByText('Choice 1 of 4')).toBeVisible();
  // Two equal buttons, neither pre-selected.
  await expect(page.getByRole('button', { name: 'Keep my diary' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Do not keep it' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep my diary' }).click();
  await page.getByRole('button', { name: 'Share with my care team' }).click();
  await page.getByRole('button', { name: "Don't include them" }).click();
  await page.getByRole('button', { name: "Don't count them" }).click();
  await expect(page.getByText('Your choices are saved.')).toBeVisible();
  const pending = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value ?? '';

  // Activation finishes: her next status check turns her session into a patient session.
  for (const tx of transactions.values()) tx.status = 'active';
  await expect(page.getByText('You are all set.')).toBeVisible({ timeout: 10_000 });
  const rotated = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  expect(rotated).not.toBe(pending);
  expect((await sessions.resolve(rotated))?.claims).toEqual({
    sub: PERSON,
    role: 'patient',
    org_id: ORG,
    patient_id: PATIENT,
  });
  // Her ids never reach the page.
  expect(await page.content()).not.toContain(PATIENT);
  expect(lastConsent).toMatchObject({
    self_tracking: { status: 'granted', version: 1 },
    share_with_care_team: { status: 'granted', version: 1 },
    research_deidentified: { status: 'declined', version: 1 },
    org_aggregate_reporting: { status: 'declined', version: 1 },
  });
  expect(violations).toEqual([]);
});

test('quick exit leaves at once, clears the tab, and Back does not return to the diary', async ({
  page,
}) => {
  transactions.clear();
  await page.goto(`${origin}/`);
  await page.goto(`${origin}/enrol#${newLink()}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(codeOf(page)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(1);
  await page.getByRole('button', { name: 'Quick exit' }).click();
  await expect(page).toHaveURL('about:blank');
  await page.goBack();
  // The diary's history entry was replaced: Back lands on the page before it, not the code.
  await expect(codeOf(page)).toHaveCount(0);
});

test('pressing Escape twice is a quick exit too', async ({ page }) => {
  await page.goto(`${origin}/enrol`);
  await expect(page.getByRole('button', { name: 'Quick exit' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('about:blank');
});

test('home: signed out she can sign in; signed in she can sign out', async ({ page, context }) => {
  await page.goto(`${origin}/`);
  const signIn = page.getByRole('link', { name: 'Sign in' });
  await expect(signIn).toHaveAttribute('href', '/auth/sign-in');

  const token = await sessions.createPatient({
    sub: PERSON,
    role: 'patient',
    org_id: ORG,
    patient_id: PATIENT,
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  await page.reload();
  await expect(page.getByText('You are signed in.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect(await sessions.resolve(token)).toBeNull();
  expect(violations).toEqual([]);
});
