import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { uuidv7 } from '@endo/domain';
import { ServiceTokenSigner, WorkloadTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from '@endo/bff-patient/app';
import { DevSessionStore } from '@endo/bff-patient/sessions';
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
let bff: Awaited<ReturnType<typeof buildBff>>;
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
  const m = /\/transactions\/([^/]+)\/(status|cancel)$/.exec(url.pathname);
  const tx = transactions.get(body['binding_hash'] ?? '');
  if (!m || !tx || tx.id !== m[1]) return reply(404, {});
  if (m[2] === 'cancel') tx.status = 'cancelling';
  return reply(200, view(tx));
}

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
    sessions: new DevSessionStore('test'),
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
