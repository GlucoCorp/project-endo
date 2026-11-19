import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startStack, type Stack } from './stack.ts';

/**
 * ADR-0021 slice 8 (and ADR-0019 7b's patient half): enrolment and sign-in against the real
 * Keycloak with our extension, the real identity service, API and patient BFF. Chromium's virtual
 * WebAuthn authenticator stands in for her phone's passkey. Synthetic data only.
 */
const url = process.env['ENDO_TEST_DATABASE_URL'];
test.skip(!url, 'needs ENDO_TEST_DATABASE_URL and Docker');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(400_000);
  stack = await startStack(url ?? '');
});
test.afterAll(async () => {
  await stack.stop();
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page
      .screenshot({ path: info.outputPath('failure.png'), fullPage: true })
      .catch(() => undefined);
    await info.attach('service-logs', {
      body: stack.logs().slice(-20_000),
      contentType: 'text/plain',
    });
  }
});

/** Her phone's passkey: a resident-key, user-verifying platform authenticator. */
async function addPasskeyDevice(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  page.on('dialog', (d) => {
    void d.accept('Synthetic phone');
  });
}

async function clinic(path: string, body: object) {
  const res = await fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await stack.clinicToken()}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  expect(res.status, `${path} ${await res.clone().text()}`).toBeLessThan(300);
  return (await res.json()) as Record<string, unknown>;
}

test('REQ-001 she enrols with a passkey on the real Keycloak, consents, and is all set', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  await addPasskeyDevice(context, page);
  const invitation = await clinic('/v1/enrolments', {});
  await page.goto(`${stack.bff}/enrol#${String(invitation['token'])}`);
  await page.getByRole('button', { name: 'Start' }).click();
  const code = page.getByLabel('Your code');
  await expect(code).toHaveText(/^[0-9]{6}$/);

  // In the clinic: the clinician confirms her by the code on her phone.
  const confirmed = await clinic(`/v1/enrolments/${String(invitation['id'])}/confirm`, {
    code: (await code.textContent()) ?? '',
    identified: true,
    own_phone: true,
  });
  expect(confirmed).toEqual({ outcome: 'confirmed' });
  await expect(page.getByText('The clinic has confirmed it is you.')).toBeVisible({
    timeout: 20_000,
  });

  // Her first passkey, in Keycloak (the guarded required action).
  await page.getByRole('button', { name: 'Create your sign-in' }).click();
  await page.waitForURL((u) => u.href.startsWith(stack.keycloak), { timeout: 30_000 });
  const register = page.getByRole('button', { name: /register|create|passkey|continue/i }).first();
  await register.click({ timeout: 30_000 });
  await page.waitForURL((u) => u.href.startsWith(stack.bff), { timeout: 60_000 });

  // Back in her app: four separate choices, then activation.
  await expect(page.getByText('Choice 1 of 4')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Keep my diary' }).click();
  await page.getByRole('button', { name: 'Share with my care team' }).click();
  await page.getByRole('button', { name: "Don't include them" }).click();
  await page.getByRole('button', { name: "Don't count them" }).click();
  await expect(page.getByText('You are all set. Your diary is ready.')).toBeVisible({
    timeout: 60_000,
  });

  // The clinical store has her record, claimed under this organisation, with her decisions.
  const claimed = await stack.clinical.query(
    'SELECT claimed_at IS NOT NULL AS claimed FROM enrolment_invitation WHERE id = $1',
    [invitation['id']],
  );
  expect(claimed.rows[0]).toEqual({ claimed: true });
  const consents = await stack.clinical.query(
    `SELECT purpose, status FROM consent_current ORDER BY purpose`,
  );
  expect(consents.rows).toEqual([
    { purpose: 'org_aggregate_reporting', status: 'declined' },
    { purpose: 'research_deidentified', status: 'declined' },
    { purpose: 'self_tracking', status: 'granted' },
    { purpose: 'share_with_care_team', status: 'granted' },
  ]);

  // The link is single use: opening it again does not start anything.
  const second = await context.newPage();
  await second.goto(`${stack.bff}/enrol#${String(invitation['token'])}`);
  await second.getByRole('button', { name: 'Start' }).click();
  await expect(second.getByText(/cannot be used|already being used/)).toBeVisible({
    timeout: 15_000,
  });
  await second.close();

  // Signing out ends her session here and in Keycloak; signing in again uses her passkey only.
  await page.goto(`${stack.bff}/`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.href.startsWith(stack.keycloak), { timeout: 30_000 });
  // ADR-0026: the email code is offered as the alternative to the passkey.
  await page.screenshot({ path: test.info().outputPath('sign-in.png') });
  await page.getByRole('link', { name: /try another way/i }).click();
  await expect(page.getByText('Email me a code')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(
    /endo-[a-z-]+-(display-name|help-text)/,
  );
  await page.screenshot({ path: test.info().outputPath('another-way.png') });
  await page.goBack();
  await page
    .getByRole('button', { name: /sign in|passkey|continue/i })
    .first()
    .click({ timeout: 30_000 });
  await page.waitForURL((u) => u.href.startsWith(stack.bff), { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 30_000 });
});

test('ADR-0021 a handoff reference is single use: replaying the Keycloak URL does not enrol again', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await addPasskeyDevice(context, page);
  const invitation = await clinic('/v1/enrolments', {});
  await page.goto(`${stack.bff}/enrol#${String(invitation['token'])}`);
  await page.getByRole('button', { name: 'Start' }).click();
  const code = page.getByLabel('Your code');
  await expect(code).toHaveText(/^[0-9]{6}$/);
  await clinic(`/v1/enrolments/${String(invitation['id'])}/confirm`, {
    code: (await code.textContent()) ?? '',
    identified: true,
    own_phone: true,
  });
  await expect(page.getByText('The clinic has confirmed it is you.')).toBeVisible({
    timeout: 20_000,
  });
  // The authorisation request carrying the handoff reference.
  const authorisation = page.waitForRequest((r) =>
    r.url().includes('/protocol/openid-connect/auth'),
  );
  await page.getByRole('button', { name: 'Create your sign-in' }).click();
  await page.waitForURL((u) => u.href.startsWith(stack.keycloak), { timeout: 30_000 });
  const keycloakUrl = (await authorisation).url();
  expect(new URL(keycloakUrl).searchParams.get('endo_handoff')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page
    .getByRole('button', { name: /register|create|passkey|continue/i })
    .first()
    .click();
  await page.waitForURL((u) => u.href.startsWith(stack.bff), { timeout: 60_000 });
  await expect(page.getByText('Choice 1 of 4')).toBeVisible({ timeout: 30_000 });

  // Someone replays the authorisation URL (with its handoff reference) in a fresh browser.
  const other = await context.browser()?.newContext();
  const replay = await other?.newPage();
  await replay?.goto(keycloakUrl);
  await replay?.waitForLoadState('networkidle');
  await replay?.screenshot({ path: test.info().outputPath('replay.png') });
  // Keycloak refuses the spent reference: no passkey registration is offered.
  await expect(replay?.locator('body') ?? page.locator('body')).toContainText('cannot be used');
  expect(await replay?.locator('body').innerText()).not.toMatch(/endo[A-Z][A-Za-z]+/);
  expect(await replay?.getByRole('button', { name: /register|create passkey/i }).count()).toBe(0);
  await other?.close();
});
