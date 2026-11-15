import { describe, expect, it } from 'vitest';
import { Admin, parseSettings } from './admin.ts';

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
