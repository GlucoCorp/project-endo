import { describe, expect, it } from 'vitest';
import { Portal } from './portal.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const INV = '01900000-0000-7000-8000-0000000000d1';

function portal(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const p = new Portal(((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? json(500, {}));
  }) as typeof fetch);
  return { p, calls };
}
const session = (state: string, extra: object = {}) => ({
  state,
  organisations: [{ index: 0, org_id: 'org-a', role: 'clinician' }],
  active: state === 'active' ? { org_id: 'org-a', role: 'clinician' } : null,
  csrf_token: 'csrf-1',
  ...extra,
});

describe('ADR-0019, ADR-0021 slice 3: clinic portal logic', () => {
  it('reads the session: signed out, choosing an organisation, active', async () => {
    const { p } = portal([
      json(401, {}),
      json(200, session('pending-org')),
      json(200, session('active')),
      json(503, {}),
      new TypeError('offline'),
      json(200, { state: 'active' }),
    ]);
    expect(await p.session()).toEqual({ kind: 'signed-out' });
    expect(await p.session()).toEqual({
      kind: 'choose-org',
      organisations: [{ index: 0, orgId: 'org-a', role: 'clinician' }],
    });
    expect(await p.session()).toEqual({ kind: 'active', role: 'clinician' });
    expect(await p.session()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await p.session()).toEqual({ kind: 'error', message: 'common.try-later' });
    // No CSRF token, no session: never act without it.
    expect(await p.session()).toEqual({ kind: 'error', message: 'common.try-later' });
  });

  it('chooses an organisation with the CSRF token and JSON, and takes the rotated token', async () => {
    const { p, calls } = portal([
      json(200, session('pending-org')),
      json(200, session('active', { csrf_token: 'csrf-2' })),
      json(200, { outcome: 'confirmed' }),
    ]);
    await p.session();
    expect(await p.chooseOrganisation(0)).toEqual({ kind: 'active', role: 'clinician' });
    expect(calls[1]).toMatchObject({
      url: '/v1/session/organisation',
      init: {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' },
      },
    });
    await p.confirm(INV, '123456', { identified: true, ownPhone: true });
    expect(calls[2]?.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-2' });
  });

  it('handles a failed organisation choice', async () => {
    const { p } = portal([json(401, {}), json(403, {}), new TypeError('offline')]);
    expect(await p.chooseOrganisation(0)).toEqual({ kind: 'signed-out' });
    expect(await p.chooseOrganisation(0)).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await p.chooseOrganisation(0)).toEqual({ kind: 'error', message: 'common.try-later' });
  });

  it('lists invitations, dropping malformed rows, or reports failure', async () => {
    const { p } = portal([
      json(200, {
        invitations: [
          { id: INV, created_at: 'c', expires_at: 'e', in_use: false },
          { id: 1, created_at: 'c' },
        ],
      }),
      json(200, {}),
      json(500, {}),
      new TypeError('offline'),
    ]);
    expect(await p.invitations()).toEqual([
      { id: INV, createdAt: 'c', expiresAt: 'e', inUse: false },
    ]);
    expect(await p.invitations()).toBeNull();
    expect(await p.invitations()).toBeNull();
    expect(await p.invitations()).toBeNull();
  });

  it('sends nothing without both attestations and a six-digit code', async () => {
    const { p, calls } = portal([]);
    expect(await p.confirm(INV, '123456', { identified: false, ownPhone: true })).toEqual({
      kind: 'error',
      message: 'clinic.attest-required',
    });
    expect(await p.confirm(INV, '123456', { identified: true, ownPhone: false })).toMatchObject({
      message: 'clinic.attest-required',
    });
    expect(await p.confirm(INV, '12a456', { identified: true, ownPhone: true })).toEqual({
      kind: 'error',
      message: 'clinic.code-format',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports every outcome of a confirmation', async () => {
    const { p, calls } = portal([
      json(200, { outcome: 'confirmed' }),
      json(200, { outcome: 'wrong', remaining: 3 }),
      json(200, { outcome: 'locked', locked_until: '2026-11-11T12:00:00Z' }),
      json(200, { outcome: 'unavailable' }),
      json(429, {}),
      json(502, {}),
      json(200, { outcome: 'maybe' }),
      new TypeError('offline'),
    ]);
    const go = () => p.confirm(INV, '123456', { identified: true, ownPhone: true });
    expect(await go()).toEqual({ kind: 'confirmed' });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      code: '123456',
      identified: true,
      own_phone: true,
    });
    expect(await go()).toEqual({ kind: 'wrong', remaining: 3 });
    expect(await go()).toEqual({ kind: 'locked', until: '2026-11-11T12:00:00Z' });
    expect(await go()).toEqual({ kind: 'unavailable' });
    expect(await go()).toEqual({ kind: 'error', message: 'common.too-many' });
    expect(await go()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await go()).toEqual({ kind: 'error', message: 'common.try-later' });
    expect(await go()).toEqual({ kind: 'error', message: 'common.try-later' });
  });
});

describe('REQ-002 the session CSRF token is shared with drafting', () => {
  it('exposes the token read from the session', async () => {
    const { p } = portal([json(200, session('active'))]);
    expect(p.csrfToken()).toBe('');
    await p.session();
    expect(p.csrfToken()).toBe('csrf-1');
  });
});
