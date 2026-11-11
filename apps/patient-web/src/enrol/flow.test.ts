import { describe, expect, it, vi } from 'vitest';
import { CODE_KEY, EnrolmentFlow, LOCK_NAME, fromServer, takeToken, type Seams } from './flow.ts';

const TOKEN = 'A'.repeat(43);
const later = new Date(Date.now() + 3_600_000).toISOString();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (status: string, extra: object = {}) => ({
  status,
  expired: false,
  state_deadline: later,
  expires_at: later,
  ...extra,
});

function seams(responses: (Response | Error)[], withLocks = true) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const store = new Map<string, string>();
  const locked: string[] = [];
  const s: Seams = {
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? json(500, {}));
    }) as typeof fetch,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    locks: withLocks
      ? ({
          request: (name: string, _o: unknown, cb: () => Promise<unknown>) => {
            locked.push(name);
            return cb();
          },
        } as unknown as Seams['locks'])
      : undefined,
  };
  return { s, calls, store, locked };
}

describe('REQ-001 ADR-0021 section 4: the link token', () => {
  it('is read from the fragment and removed from the address bar', () => {
    const replaceState = vi.fn();
    expect(takeToken({ hash: `#${TOKEN}`, pathname: '/enrol', search: '' }, { replaceState })).toBe(
      TOKEN,
    );
    expect(replaceState).toHaveBeenCalledWith(null, '', '/enrol');
  });

  it('is refused when malformed, and still removed', () => {
    const replaceState = vi.fn();
    expect(
      takeToken({ hash: '#short', pathname: '/enrol', search: '?a=1' }, { replaceState }),
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/enrol?a=1');
    const untouched = vi.fn();
    expect(
      takeToken({ hash: '', pathname: '/enrol', search: '' }, { replaceState: untouched }),
    ).toBeNull();
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe('REQ-001 ADR-0021 sections 3 and 4: the enrolment flow in the browser', () => {
  it('starts under the cross-tab lock, posts JSON, and keeps the code in this tab', async () => {
    const { s, calls, store, locked } = seams([
      json(201, view('awaiting-confirmation', { code: '123456' })),
    ]);
    expect(await new EnrolmentFlow(s).start(TOKEN)).toEqual({
      kind: 'code',
      code: '123456',
      status: 'awaiting-confirmation',
    });
    expect(locked).toEqual([LOCK_NAME]);
    expect(calls[0]?.url).toBe('/v1/enrolment/start');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ token: TOKEN });
    expect(store.get(CODE_KEY)).toBe('123456');
  });

  it('shows the stored code after a repeated Start, or says it is in another tab', async () => {
    const a = seams([json(200, view('awaiting-confirmation'))]);
    a.store.set(CODE_KEY, '654321');
    expect(await new EnrolmentFlow(a.s).start(TOKEN)).toMatchObject({ code: '654321' });
    const b = seams([json(200, view('awaiting-confirmation'))], false);
    expect(await new EnrolmentFlow(b.s).start(TOKEN)).toMatchObject({ kind: 'code', code: null });
  });

  it.each([
    ['enrolment.link_invalid', 404, 'enrol.link-invalid'],
    ['enrolment.locked', 409, 'enrol.locked'],
    ['enrolment.busy', 409, 'enrol.busy'],
    ['enrolment.unavailable', 409, 'enrol.unavailable'],
    ['something.else', 409, 'common.try-later'],
  ])('maps %s to a plain message', async (code, status, message) => {
    const { s } = seams([json(status, { type: `https://errors.glucorp.health/${code}` })]);
    expect(await new EnrolmentFlow(s).start(TOKEN)).toEqual({ kind: 'error', message });
  });

  it('handles rate limits, unreadable answers and a lost connection', async () => {
    expect(await new EnrolmentFlow(seams([json(429, {})]).s).start(TOKEN)).toEqual({
      kind: 'error',
      message: 'common.too-many',
    });
    expect(
      await new EnrolmentFlow(seams([new Response('x', { status: 502 })]).s).start(TOKEN),
    ).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await new EnrolmentFlow(seams([new TypeError('offline')]).s).start(TOKEN)).toEqual({
      kind: 'error',
      message: 'common.try-later',
    });
  });

  it('follows the status, and forgets the code once confirmation is over', async () => {
    const { s, store } = seams([
      json(200, view('awaiting-confirmation')),
      json(200, view('confirmed')),
      json(200, view('awaiting-confirmation', { expired: true })),
      json(200, view('cancelling')),
      json(404, {}),
      json(500, {}),
      new TypeError('offline'),
    ]);
    store.set(CODE_KEY, '111111');
    const flow = new EnrolmentFlow(s);
    expect(await flow.status()).toMatchObject({ kind: 'code', code: '111111' });
    expect(await flow.status()).toEqual({ kind: 'confirmed' });
    expect(store.has(CODE_KEY)).toBe(false);
    expect(await flow.status()).toEqual({ kind: 'ended', message: 'enrol.expired' });
    expect(await flow.status()).toEqual({ kind: 'ended', message: 'enrol.cancelled' });
    expect(await flow.status()).toEqual({ kind: 'ended', message: 'enrol.expired' });
    expect(await flow.status()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.status()).toEqual({ kind: 'error', message: 'common.try-later' });
  });

  it('resumes after a reload from the cookie, or says to open the link', async () => {
    const { s, store } = seams([
      json(200, view('awaiting-confirmation')),
      json(404, {}),
      json(503, {}),
      new TypeError('offline'),
    ]);
    store.set(CODE_KEY, '222222');
    const flow = new EnrolmentFlow(s);
    expect(await flow.resume()).toMatchObject({ kind: 'code', code: '222222' });
    expect(await flow.resume()).toEqual({ kind: 'no-link' });
    expect(await flow.resume()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.resume()).toEqual({ kind: 'error', message: 'common.try-later' });
  });

  it('stops, and clears the code', async () => {
    const { s, store, calls } = seams([
      json(200, view('cancelling')),
      json(404, {}),
      json(409, {}),
      new TypeError('offline'),
    ]);
    store.set(CODE_KEY, '333333');
    const flow = new EnrolmentFlow(s);
    expect(await flow.cancel()).toEqual({ kind: 'ended', message: 'enrol.stopped' });
    expect(store.has(CODE_KEY)).toBe(false);
    expect(calls[0]).toMatchObject({ url: '/v1/enrolment/cancel', init: { method: 'POST' } });
    expect(await flow.cancel()).toEqual({ kind: 'ended', message: 'enrol.stopped' });
    expect(await flow.cancel()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.cancel()).toEqual({ kind: 'error', message: 'common.try-later' });
  });

  it('never trusts a malformed stored code', () => {
    expect(fromServer({ status: 'awaiting-confirmation', expired: false }, null)).toMatchObject({
      code: null,
    });
  });

  it('continues to Keycloak only at an HTTPS address (or this machine during development)', async () => {
    const { s, calls } = seams([
      json(200, { location: 'https://kc.example/realms/endo/auth?endo_handoff=x' }),
      json(200, { location: 'http://localhost:18080/realms/endo/auth' }),
      json(200, { location: 'http://evil.test/auth' }),
      json(200, { location: 'javascript:alert(1)' }),
      json(200, {}),
      json(404, {}),
      json(409, {}),
      new TypeError('offline'),
    ]);
    const flow = new EnrolmentFlow(s);
    expect(await flow.continue()).toEqual({
      kind: 'navigate',
      url: 'https://kc.example/realms/endo/auth?endo_handoff=x',
    });
    expect(calls[0]).toMatchObject({ url: '/v1/enrolment/continue', init: { method: 'POST' } });
    expect(await flow.continue()).toMatchObject({ kind: 'navigate' });
    expect(await flow.continue()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.continue()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.continue()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.continue()).toEqual({ kind: 'ended', message: 'enrol.expired' });
    expect(await flow.continue()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.continue()).toEqual({ kind: 'error', message: 'common.try-later' });
  });

  it('shows her sign-in being finished, then ready', () => {
    for (const status of ['redeemed', 'credential-committed'])
      expect(fromServer({ status, expired: false }, null)).toEqual({ kind: 'signing-in' });
    expect(fromServer({ status: 'consent-pending', expired: false }, null)).toEqual({
      kind: 'signed-in',
    });
    for (const status of ['claiming', 'activating', 'active'])
      expect(fromServer({ status, expired: false }, null)).toEqual({ kind: 'consented' });
    expect(fromServer({ status: 'confirmed', expired: false }, null)).toEqual({
      kind: 'confirmed',
    });
  });

  it('sends her decisions and shows the outcome', async () => {
    const { s, calls } = seams([
      json(200, view('claiming')),
      json(200, view('cancelling')),
      json(404, {}),
      json(409, {}),
      new TypeError('offline'),
    ]);
    const flow = new EnrolmentFlow(s);
    const decisions = { self_tracking: { status: 'granted', version: 1, decided_at: 'x' } };
    expect(await flow.consent(decisions)).toEqual({ kind: 'consented' });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ decisions });
    expect(await flow.consent(decisions)).toEqual({ kind: 'ended', message: 'consent.declined' });
    expect(await flow.consent(decisions)).toEqual({ kind: 'ended', message: 'enrol.expired' });
    expect(await flow.consent(decisions)).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await flow.consent(decisions)).toEqual({ kind: 'error', message: 'common.try-later' });
  });
});
