import { describe, expect, it } from 'vitest';
import { Admin, dashboard, joinToken, parseSettings, startJoin } from './admin.ts';

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
function fake(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? json(500);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as unknown as typeof fetch;
  return { admin: new Admin(f, () => 'csrf-token'), calls };
}

describe('REQ-010 organisation admin logic', () => {
  it('parses the settings form, refusing what cannot be right', () => {
    expect(parseSettings('8', 'en, sw, en', '112')).toEqual({
      default_review_interval_weeks: 8,
      languages: ['en', 'sw'],
      emergency_number: '112',
    });
    expect(parseSettings('', 'en', '')).toEqual({
      default_review_interval_weeks: null,
      languages: ['en'],
      emergency_number: null,
    });
    expect(parseSettings('3', 'en', '')).toBeNull();
    expect(parseSettings('8.5', 'en', '')).toBeNull();
    expect(parseSettings('8', '', '')).toBeNull();
    expect(parseSettings('8', 'English', '')).toBeNull();
    expect(parseSettings('8', 'en', '+44 999')).toBeNull();
  });

  it('reads and saves settings with the CSRF token and a key', async () => {
    const saved = { default_review_interval_weeks: 8, languages: ['en'], emergency_number: '112' };
    const { admin, calls } = fake([
      json(200, saved),
      json(500),
      new TypeError('x'),
      json(200, saved),
      json(400, { type: 'https://errors.endo/request.invalid' }),
      json(502),
      new TypeError('x'),
    ]);
    expect(await admin.settings()).toEqual(saved);
    expect(await admin.settings()).toBeNull();
    expect(await admin.settings()).toBeNull();
    expect(await admin.saveSettings(saved)).toEqual({ kind: 'ok', value: saved });
    const headers = new Headers(calls[3]?.init?.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf-token');
    expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await admin.saveSettings(saved)).toEqual({ kind: 'refused', code: 'request.invalid' });
    expect(await admin.saveSettings(saved)).toEqual({ kind: 'error' });
    expect(await admin.saveSettings(saved)).toEqual({ kind: 'error' });
  });

  it('lists members and changes one', async () => {
    const { admin, calls } = fake([
      json(200, { clinicians: [{ clinician_id: 'c', role: 'clinician', active: true }] }),
      json(500),
      json(200, { clinician_id: 'c' }),
      json(409, { type: 'https://errors.endo/org.last_admin' }),
      new Response('not json', { status: 409 }),
    ]);
    expect(await admin.members()).toHaveLength(1);
    expect(await admin.members()).toBeNull();
    expect((await admin.change('c', 'clinician', false)).kind).toBe('ok');
    expect(calls[2]?.url).toBe('/v1/org/clinicians/c');
    expect(JSON.parse(calls[2]?.init?.body as string)).toEqual({
      role: 'clinician',
      active: false,
    });
    expect(await admin.change('c', 'org_admin', true)).toEqual({
      kind: 'refused',
      code: 'org.last_admin',
    });
    expect(await admin.change('c', 'org_admin', true)).toEqual({ kind: 'refused', code: '' });
  });
});

describe('REQ-010 staff invitations in the portal', () => {
  it('makes a link with the token in its fragment, lists and stops invitations', async () => {
    const T = 'K'.repeat(43);
    const { admin, calls } = fake([
      json(201, { token: T, expires_at: '2026-11-23T00:00:00Z' }),
      json(201, { expires_at: 'x' }),
      json(403, { type: 'https://errors.endo/authz.denied' }),
      json(200, { invitations: [{ id: 'i', status: 'open' }] }),
      json(500),
      new Response(null, { status: 204 }),
      json(404),
      new TypeError('x'),
    ]);
    expect(await admin.invite('clinician', 'https://clinic.test')).toEqual({
      kind: 'ok',
      value: { url: `https://clinic.test/join#${T}`, expiresAt: '2026-11-23T00:00:00Z' },
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ role: 'clinician' });
    expect(await admin.invite('clinician', 'x')).toEqual({ kind: 'error' });
    expect(await admin.invite('clinician', 'x')).toEqual({ kind: 'refused', code: 'authz.denied' });
    expect(await admin.invitations()).toHaveLength(1);
    expect(await admin.invitations()).toBeNull();
    expect(await admin.stopInvitation('i')).toBe(true);
    expect(calls[5]?.url).toBe('/v1/org/staff-invitations/i/revoke');
    expect(await admin.stopInvitation('i')).toBe(false);
    expect(await admin.stopInvitation('i')).toBe(false);
  });

  it('reads the join token from the fragment and hands it to the BFF', async () => {
    expect(joinToken(`#${'K'.repeat(43)}`)).toBe('K'.repeat(43));
    expect(joinToken('#short')).toBeNull();
    const calls: RequestInit[] = [];
    const answers: (Response | Error)[] = [
      new Response(null, { status: 204 }),
      new Response(null, { status: 400 }),
      new TypeError('x'),
    ];
    const f = ((_u: string, init?: RequestInit) => {
      calls.push(init ?? {});
      const r = answers.shift() ?? new Response(null, { status: 500 });
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }) as unknown as typeof fetch;
    expect(await startJoin(f, 'K'.repeat(43))).toBe(true);
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ token: 'K'.repeat(43) });
    expect(await startJoin(f, 'K'.repeat(43))).toBe(false);
    expect(await startJoin(f, 'K'.repeat(43))).toBe(false);
  });
});

describe('REQ-011 dashboard client', () => {
  it('reads the dashboard, or null', async () => {
    const answers: (Response | Error)[] = [
      new Response(JSON.stringify({ min_cell: 10 }), { status: 200 }),
      new Response('{}', { status: 403 }),
      new TypeError('x'),
    ];
    const urls: string[] = [];
    const f = ((u: string) => {
      urls.push(u);
      const r = answers.shift() ?? new Response(null, { status: 500 });
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }) as unknown as typeof fetch;
    expect(await dashboard(f)).toEqual({ min_cell: 10 });
    expect(urls[0]).toBe('/v1/dashboard');
    expect(await dashboard(f)).toBeNull();
    expect(await dashboard(f)).toBeNull();
  });
});
