import { describe, expect, it } from 'vitest';
import { checkSession, lockNow, setAppLock, signOut } from './session.ts';

const answer = (status: number, body: unknown = {}) =>
  (() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
const offline = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;

describe('REQ-001 home: signed in, locked or not, never her ids', () => {
  it('reads the session state', async () => {
    expect(
      await checkSession(answer(200, { signed_in: true, locked: false, app_lock: true })),
    ).toEqual({ kind: 'signed-in', appLock: true });
    expect(await checkSession(answer(200, { signed_in: true, locked: true }))).toEqual({
      kind: 'locked',
    });
    expect(await checkSession(answer(401))).toEqual({ kind: 'signed-out' });
    expect(await checkSession(answer(500))).toEqual({ kind: 'error' });
    expect(await checkSession(answer(200, { signed_in: true }))).toEqual({ kind: 'error' });
    expect(await checkSession(offline)).toEqual({ kind: 'error' });
  });

  it('signs out, sets app lock and locks with same-origin JSON POSTs', async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const record = (status: number) =>
      (async (url: string, init?: RequestInit) => {
        seen.push([url, init]);
        return Promise.resolve(new Response(null, { status }));
      }) as unknown as typeof fetch;
    expect(await signOut(record(204))).toBe(true);
    expect(await setAppLock(record(200), true)).toBe(true);
    lockNow(record(204));
    expect(seen.map(([u]) => u)).toEqual([
      '/v1/session/sign-out',
      '/v1/session/app-lock',
      '/v1/session/lock',
    ]);
    expect(seen[1]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    // Leaving the app: sent even as the page is put away.
    expect(seen[2]?.[1]).toMatchObject({ keepalive: true });
    expect(await signOut(answer(403))).toBe(false);
    expect(await signOut(offline)).toBe(false);
    expect(await setAppLock(answer(401), true)).toBe(false);
    expect(await setAppLock(offline, false)).toBe(false);
    lockNow(offline);
  });
});
