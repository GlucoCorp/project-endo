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
      // REQ-001: once she has accepted (and here declined sharing), only that is shown.
      accepted: confirmed
        ? [{ id: INVITATION, accepted_at: '2026-11-11T09:00:00Z', sharing: 'declined' }]
        : [],
    });
  if (path === `/v1/enrolments/${INVITATION}/confirm`) {
    if (body?.['code'] === CODE) {
      confirmed = true;
      return reply({ outcome: 'confirmed' });
    }
    wrongLeft -= 1;
    return reply({ outcome: 'wrong', remaining: wrongLeft });
  }
  // M4 desk (REQ-005, REQ-006).
  const PATIENT = '01900000-0000-7000-8000-0000000000a1';
  const EPISODE = '01900000-0000-7000-8000-0000000000e5';
  if (path === '/v1/reviews/queue')
    return reply({
      verdicts: 'shadow',
      items: [
        {
          episode_id: EPISODE,
          patient_id: PATIENT,
          treatment: { code: 'SYNTH-DAILY', display: 'Synthetic daily tablet' },
          dose_text: '1 daily',
          review_date: '2026-11-10',
          overdue: true,
          week: 12,
          check_ins: 2,
          red_flags: 1,
        },
      ],
    });
  if (path === '/v1/catalogue')
    return reply({
      draft: true,
      treatments: [
        {
          system: 'urn:endo:synthetic',
          code: 'SYNTH-DEVICE',
          display: 'Synthetic device',
          adherence_mode: 'device_or_injection',
        },
      ],
    });
  if (path === `/v1/patients/${PATIENT}/episodes/${EPISODE}/review`)
    return reply({
      verdicts: 'shadow',
      episode: {
        id: EPISODE,
        status: 'active',
        treatment: { code: 'SYNTH-DAILY', display: 'Synthetic daily tablet' },
        dose_text: '1 daily',
        adherence_mode: 'daily',
        start_date: '2026-08-18',
        review_date: '2026-11-10',
        review_interval_weeks: 12,
        goal: 'Synthetic goal A',
      },
      weeks: [
        {
          week_index: 1,
          is_late: false,
          answers: { Q1: 8, Q3: 'no', Q5: [], Q7: 7, Q8: ['none'] },
        },
        {
          week_index: 3,
          is_late: false,
          answers: { Q1: 4, Q3: 'yes', Q5: ['x'], Q6: 'a_lot', Q7: 6, Q8: ['cost'] },
        },
      ],
      red_flags: [{ flags: ['RF3'], recorded_at: '2026-09-01T10:00:00Z' }],
      history: [],
      decisions: [],
      guideline_options: [],
      decision_options: ['continue', 'switch', 'add', 'refer', 'stop'],
    });
  if (path === `/v1/patients/${PATIENT}/episodes/${EPISODE}/decision`) {
    lastDecision = body;
    return reply({ id: 'd', decision: body?.['decision'] });
  }
  if (path === `/v1/patients/${PATIENT}/surgery-checks/preview`)
    return reply({
      procedure: body?.['procedure'],
      snapshot_hash: 'e'.repeat(64),
      treatments: [
        {
          treatment: { code: 'SYNTH-DAILY', display: 'Synthetic daily tablet' },
          start_date: '2026-08-18',
          weeks_planned: 12,
          check_ins: 2,
          adherence: 0.929,
          decision: null,
          classification: 'pending_clinical_definition',
        },
      ],
    });
  if (path === `/v1/patients/${PATIENT}/surgery-checks`) {
    lastSurgery = body;
    return reply({ id: 'c' });
  }
  return new Response('{}', { status: 404 });
}
let lastDecision: Record<string, unknown> | null = null;
let lastSurgery: Record<string, unknown> | null = null;

let bff: Awaited<ReturnType<typeof buildClinicBff>>;
let origin = '';
let sessionCookie = '';
let sessions: InMemoryClinicSessions;
const ISSUER = 'https://kc.test/realms/endo';
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
  sessions = new InMemoryClinicSessions('test');
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
  await expect(page.getByText('Invitation accepted')).toBeVisible();
  await expect(page.getByText('Sharing declined.')).toBeVisible();
  expect(violations).toEqual([]);
});

test('signed out, the portal offers sign-in', async ({ page }) => {
  await page.goto(`${origin}/`);
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login');
});

test('REQ-005, REQ-006 the desk: queue, review with the Trial Strip, decision, pre-surgery check', async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: await sessions.create({
        personId: '01900000-0000-7000-8000-0000000000e2',
        issuer: ISSUER,
        subject: 'kc-2',
        sid: null,
        idToken: 'id',
        refresh: await new EnvelopeSealer(new DevKeyManager('test'), 'kms/identity').seal(
          'rt',
          'ctx',
        ),
        memberships: [{ orgId: ORG, role: 'clinician' }],
      }),
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  await page.goto(`${origin}/`);
  const choose = page.getByRole('button', { name: /as clinician/ });
  const ready = page.getByRole('heading', { name: 'Confirm a patient' });
  await expect(choose.or(ready)).toBeVisible();
  if (await choose.isVisible()) await choose.click();
  await expect(ready).toBeVisible();
  await page.goto(`${origin}/reviews`);
  await expect(page.getByRole('heading', { name: 'Reviews due' })).toBeVisible();
  await expect(page.getByText('Red flags reported: 1')).toBeVisible();
  await expect(page.getByText('Overdue since 2026-11-10')).toBeVisible();
  // Keyboard: Enter opens the selected review.
  await page.getByRole('list', { name: 'Reviews due' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Synthetic daily tablet, 1 daily' }),
  ).toBeVisible();
  await expect(page.getByText('“Synthetic goal A”')).toBeVisible();
  await expect(page.getByText('not shown yet', { exact: false }).first()).toBeVisible();
  const strip = page.getByRole('img', { name: /Weekly check-ins from 2026-08-18/ });
  await expect(strip).toBeVisible();
  // The equivalent table says the same in words; week 2 is "No entry", never zero.
  await expect(page.locator('table')).toContainText('No entry');
  await expect(page.locator('table')).toContainText('Worst pain 4 of 10, goal met');
  // 5 chooses "Stop"; Ctrl+Enter records it.
  await page.keyboard.press('5');
  await expect(page.getByLabel('5. Stop')).toBeChecked();
  await page.getByLabel('Note (optional)').fill('Synthetic note');
  await page.getByLabel('Note (optional)').press('Control+Enter');
  await expect(page.getByText('Decision recorded.', { exact: false })).toBeVisible();
  expect(lastDecision).toEqual({ decision: 'stop', note: 'Synthetic note' });
  // Pre-surgery check: facts, then saved only once discussed.
  await page.getByLabel('Procedure being considered').selectOption('hysterectomy');
  await expect(
    page.getByText('Synthetic daily tablet: 2 of 12 weekly check-ins, taken 93%'),
  ).toBeVisible();
  const save = page.getByRole('button', { name: 'Save the check' });
  await expect(save).toBeDisabled();
  await page.getByLabel('I have discussed these with the patient.').check();
  await save.click();
  await expect(page.getByText('Check saved.', { exact: false })).toBeVisible();
  expect(lastSurgery).toEqual({
    procedure: 'hysterectomy',
    discussed_with_patient: true,
    snapshot_hash: 'e'.repeat(64),
  });
  expect(violations).toEqual([]);
});
