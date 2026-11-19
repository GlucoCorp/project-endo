import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ServiceTokenSigner, WorkloadTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from '@endo/bff-patient/app';
import { DevSessionStore, SESSION_COOKIE } from '@endo/bff-patient/sessions';
import { loadAppShell } from '@endo/bff-patient/app-shell';

/**
 * M2 in a real browser (REQ-002, REQ-003, REQ-007; spec 14): the real patient BFF serves the built
 * app; only the core API is a stand-in. She sets her goal, does a check-in where she reports a red
 * flag (the urgent screen shows before anything is sent), then does one offline: it is kept
 * encrypted on the phone and sent when she is back online. Quick exit destroys the queue.
 */
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const PATIENT = {
  sub: '01900000-0000-7000-8000-0000000000e1',
  role: 'patient' as const,
  org_id: '01900000-0000-7000-8000-0000000000e3',
  patient_id: '01900000-0000-7000-8000-0000000000e2',
};
const sessions = new DevSessionStore('test');
let bff: Awaited<ReturnType<typeof buildBff>>;
let origin = '';
let violations: string[] = [];

const api = {
  status: 'draft' as 'draft' | 'active',
  goal: null as string | null,
  openWeeks: [1] as number[],
  done: [] as number[],
  calls: [] as { path: string; key: string | null; body: Record<string, unknown> }[],
};
const shared = {
  made: false,
  stopped: false,
  hash: createHash('sha256').update('S'.repeat(43)).digest('hex'),
};
const content = {
  draft: true,
  instrument_version: '1.0.0',
  text: {
    Q1: 'On your worst day this week, how bad was the pain?',
    Q2: 'Did pain stop you?',
    Q3: 'This week, did you manage: {goal}?',
    Q5: 'Side effects?',
    Q6: 'How much?',
    Q7: 'On how many days did you take it as prescribed?',
    Q8: 'Did anything get in the way?',
  },
  options: {
    Q2: ['none', 'some_days'],
    Q3: ['yes', 'no'],
    Q5: ['synthetic_effect_a'],
    Q6: ['a_little'],
    Q8: ['none', 'cost'],
  },
  review_weeks: [4],
  red_flags: [
    { id: 'RF1', text: 'Soaking through a pad', routes_to: null },
    { id: 'RF3', text: 'Sudden severe pain', routes_to: null },
  ],
  goals: [{ code: 'synthetic_goal_a', text: 'Synthetic goal A (placeholder)' }],
};
const episode = () => ({
  id: EPISODE,
  status: api.status,
  treatment: {
    system: 'urn:endo:synthetic',
    code: 'SYNTH-DAILY',
    display: 'Synthetic daily tablet (placeholder)',
  },
  dose_text: '1 tablet daily',
  adherence_mode: 'daily',
  start_date: '2026-11-01',
  review_date: '2027-01-24',
  review_interval_weeks: 12,
  goal: api.goal ? { template_code: 'synthetic_goal_a', text: api.goal } : null,
  check_ins: api.done.map((w) => ({ week_index: w, is_late: false })),
  open_weeks: api.openWeeks.filter((w) => !api.done.includes(w)),
});
const rights = { deletion: 'none' as 'none' | 'scheduled' | 'cancelled' };
const deletion = () =>
  rights.deletion === 'none'
    ? { status: 'none' }
    : {
        status: rights.deletion,
        requested_at: '2026-11-15T10:00:00Z',
        due_at: '2026-11-29T10:00:00Z',
      };
function fakeApi(url: URL, init: RequestInit): Response {
  const reply = (status: number, b: unknown) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
  api.calls.push({
    path: url.pathname,
    key: new Headers(init.headers).get('idempotency-key'),
    body,
  });
  if (url.pathname === '/v1/me/episodes') return reply(200, { episodes: [episode()] });
  // M4 (REQ-008): history, sharing, access log, and a receiver's view.
  const card = {
    id: EPISODE,
    status: 'closed',
    treatment: { code: 'SYNTH-DAILY', display: 'Synthetic daily tablet (placeholder)' },
    dose_text: '1 tablet daily',
    start_date: '2026-08-01',
    review_date: '2026-10-24',
    review_interval_weeks: 12,
    goal: 'Synthetic goal A (placeholder)',
    decision: 'switch',
    weeks: [{ week_index: 1, is_late: false, answers: { Q1: 7, Q7: 7, Q8: ['none'] } }],
  };
  if (url.pathname === '/v1/me/history') return reply(200, { treatments: [card] });
  if (url.pathname === '/v1/me/share-links' && init.method === 'POST') {
    shared.made = true;
    return reply(201, { id: 'l1', token: 'S'.repeat(43), expires_at: '2026-11-22T00:00:00Z' });
  }
  if (url.pathname === '/v1/me/share-links')
    return reply(200, {
      links: shared.made
        ? [
            {
              id: '01900000-0000-7000-8000-0000000000d9',
              created_at: '2026-11-15',
              expires_at: '2026-11-22T00:00:00Z',
              active: !shared.stopped,
            },
          ]
        : [],
    });
  if (url.pathname.startsWith('/v1/me/share-links/') && init.method === 'DELETE') {
    shared.stopped = true;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/v1/me/access-log')
    return reply(200, {
      events: [
        {
          at: '2026-11-15T10:00:00Z',
          role: 'clinician',
          action: 'patient_data.read',
          purpose: 'treatment',
          outcome: 'success',
        },
      ],
    });
  if (url.pathname === '/internal/v1/shared/view')
    return body['token_hash'] === shared.hash
      ? reply(200, { expires_at: '2026-11-22T00:00:00Z', treatments: [card] })
      : reply(404, {});
  // M5 (REQ-009): deletion and export.
  if (url.pathname === '/v1/me/deletion' && init.method === 'POST') {
    rights.deletion = 'scheduled';
    return reply(202, deletion());
  }
  if (url.pathname === '/v1/me/deletion') return reply(200, deletion());
  if (url.pathname === '/v1/me/deletion/cancel') {
    rights.deletion = 'cancelled';
    return reply(200, deletion());
  }
  if (url.pathname === '/v1/me/export')
    return new Response(JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: [] }), {
      status: 200,
      headers: { 'content-type': 'application/fhir+json' },
    });
  if (url.pathname === '/v1/me/checkin-content') return reply(200, content);
  if (url.pathname.endsWith('/confirm')) {
    api.status = 'active';
    api.goal = 'Synthetic goal A (placeholder)';
    return reply(200, episode());
  }
  if (url.pathname.endsWith('/red-flags'))
    return reply(201, { id: 'rf', recorded_at: new Date().toISOString() });
  if (url.pathname.endsWith('/checkins')) {
    api.done.push(body['week_index'] as number);
    return reply(201, {
      id: 'c',
      week_index: body['week_index'],
      open_weeks: episode().open_weeks,
    });
  }
  return reply(404, {});
}

test.beforeAll(async () => {
  const service = await generateServiceKeyPair();
  const workload = await generateServiceKeyPair();
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
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Promise.resolve(fakeApi(new URL(input instanceof Request ? input.url : input), init ?? {})),
    appShell: loadAppShell(DIST),
    emergencyNumber: '112',
    enrolment: {
      identityBaseUrl: 'http://identity.invalid',
      signer: new WorkloadTokenSigner(workload.privateJwk, 'bff-patient'),
      patientOrigin: origin,
      fetch: () => Promise.reject(new Error('unused')),
      now: () => new Date(),
    },
  });
  await bff.listen({ host: 'localhost', port });
});

test.afterAll(() => bff.close());

async function signIn(context: BrowserContext, page: Page) {
  violations = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Trusted Type/i.test(m.text())) violations.push(m.text());
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: await sessions.createPatient(PATIENT),
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

async function answerWeek(page: Page) {
  await page.getByRole('button', { name: '5', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('none').check();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(
    page.getByText('This week, did you manage: Synthetic goal A (placeholder)?'),
  ).toBeVisible();
  await page.getByLabel('yes').check();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'None', exact: true }).click(); // no side effects
  await page.getByRole('button', { name: '7', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('cost').check();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
}

test('REQ-002, REQ-003, REQ-007 goal, a red flag, then an offline check-in synced later', async ({
  context,
  page,
}) => {
  await signIn(context, page);
  await page.goto(`${origin}/`);

  // Her goal starts the trial.
  await expect(
    page.getByRole('heading', { name: 'What would make this treatment worth it for you?' }),
  ).toBeVisible();
  await expect(
    page.getByText('Draft wording, not yet approved by clinicians.', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('Synthetic goal A (placeholder)').check();
  await page.getByRole('button', { name: 'Start this treatment' }).click();
  await expect(page.getByText('“Synthetic goal A (placeholder)”')).toBeVisible();
  const confirm = api.calls.find((c) => c.path.endsWith('/confirm'));
  expect(confirm?.body['goal']).toEqual({ template_code: 'synthetic_goal_a' });
  expect(typeof confirm?.body['time_zone']).toBe('string');

  // Week 1: red flags first, never skippable; reporting one shows the urgent screen at once.
  await page.getByRole('button', { name: 'Start this week’s check-in' }).click();
  await expect(page.getByText('1 of 7')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  await page.getByLabel('Sudden severe pain').check();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get urgent care now' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call 112' })).toHaveAttribute('href', 'tel:112');
  await expect
    .poll(() => api.calls.filter((c) => c.path.endsWith('/red-flags')).length)
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'I understand' }).click();
  await answerWeek(page);
  await expect(page.getByText('Saved.')).toBeVisible();
  const week1 = api.calls.find((c) => c.path.endsWith('/checkins'));
  expect(week1?.body['answers']).toEqual({
    red_flags: ['RF3'],
    Q1: 5,
    Q2: 'none',
    Q3: 'yes',
    Q5: [],
    Q7: 7,
    Q8: ['cost'],
  });
  // The early report and the check-in share one derived key: every red-flag call uses it.
  const rfKeys = new Set(api.calls.filter((c) => c.path.endsWith('/red-flags')).map((c) => c.key));
  expect(rfKeys.size).toBe(1);

  // Week 2 offline: kept on the phone, encrypted, then sent when she is back online.
  api.openWeeks = [1, 2];
  await page.reload();
  await page.getByRole('button', { name: 'Start this week’s check-in' }).click();
  await page.getByRole('button', { name: 'None of these' }).click();
  await context.setOffline(true);
  await answerWeek(page);
  await expect(page.getByText('Saved on this phone.', { exact: false })).toBeVisible();
  const stored = await page.evaluate(
    () =>
      new Promise<{ entries: number; extractable: boolean | null; plain: boolean }>((resolve) => {
        const req = indexedDB.open('endo-offline');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['entries', 'keys'], 'readonly');
          const all = tx.objectStore('entries').getAll();
          const key = tx.objectStore('keys').get('queue');
          tx.oncomplete = () => {
            const entries = all.result as { data: ArrayBuffer }[];
            const text = entries.map((e) => new TextDecoder().decode(e.data)).join('');
            resolve({
              entries: entries.length,
              extractable: (key.result as CryptoKey | undefined)?.extractable ?? null,
              plain: text.includes('week_index'),
            });
          };
        };
      }),
  );
  expect(stored).toEqual({ entries: 1, extractable: false, plain: false });
  const before = api.calls.filter((c) => c.path.endsWith('/checkins')).length;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(() => api.calls.filter((c) => c.path.endsWith('/checkins')).length)
    .toBe(before + 1);
  expect(api.done).toEqual([1, 2]);

  // Quick exit: the screen goes, the session ends, the queue and its key are destroyed.
  await page.getByRole('button', { name: 'Quick exit' }).click();
  await expect(page).toHaveURL('about:blank');
  expect(violations).toEqual([]);
});

test('REQ-008 her history, a share link the receiver opens, stopping it, and her access log', async ({
  context,
  page,
  browser,
}) => {
  await signIn(context, page);
  await page.goto(`${origin}/history`);
  await expect(page.getByRole('heading', { name: 'Your treatments' })).toBeVisible();
  await expect(page.getByText('“Synthetic goal A (placeholder)”')).toBeVisible();
  await expect(page.getByRole('img', { name: /Weekly check-ins from 2026-08-01/ })).toBeVisible();
  await expect(page.getByText('They do not see your name', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Make a link' }).click();
  const link = await page.getByLabel('Share link').inputValue();
  expect(link).toBe(`${origin}/shared#${'S'.repeat(43)}`);
  await expect(page.getByText('A link works until 2026-11-22.')).toBeVisible();
  await expect(page.getByText('2026-11-15 10:00: clinician, patient data read')).toBeVisible();

  // The receiver: no session; the token never appears in a request URL or the address bar.
  const other = await browser.newContext();
  const receiver = await other.newPage();
  const urls: string[] = [];
  receiver.on('request', (r) => urls.push(r.url()));
  await receiver.goto(link);
  await expect(receiver.getByRole('heading', { name: 'Shared treatment summary' })).toBeVisible();
  await expect(receiver.getByText('Shared until 2026-11-22.')).toBeVisible();
  await expect(receiver.getByText('“Synthetic goal A (placeholder)”')).toBeVisible();
  expect(receiver.url()).toBe(`${origin}/shared`);
  expect(urls.some((u) => u.includes('S'.repeat(43)))).toBe(false);
  await other.close();

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(page.getByText('A link works until 2026-11-22.')).toHaveCount(0);
  expect(violations).toEqual([]);
});

test('REQ-009 she downloads her record, asks for deletion and changes her mind', async ({
  context,
  page,
}) => {
  await signIn(context, page);
  await page.goto(origin);
  await page.getByRole('link', { name: 'Your data: download or delete' }).click();
  await expect(page.getByRole('heading', { name: 'Your data' })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my record' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('my-endo-record.json');
  const path = await file.path();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ resourceType: 'Bundle' });
  await expect(page.getByText('Your record has downloaded.', { exact: false })).toBeVisible();

  const remove = page.getByRole('button', { name: 'Delete my account' });
  await expect(remove).toBeDisabled();
  await page.getByLabel('I understand my record will be deleted and cannot be recovered.').check();
  await remove.click();
  await expect(
    page.getByText('Your account will be deleted on 2026-11-29.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep my account' }).click();
  await expect(page.getByText('Your account is kept.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
  expect(violations).toEqual([]);
});
