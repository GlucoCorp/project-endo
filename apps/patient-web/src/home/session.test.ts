import { describe, expect, it } from 'vitest';
import { checkSession, signOut } from './session.ts';

const answer = (status: number, body: unknown = {}) =>
  (() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;

describe('REQ-001 home: signed in or not, never her ids', () => {
  it('reads the session state', async () => {
    expect(await checkSession(answer(200, { signed_in: true }))).toBe('signed-in');
    expect(await checkSession(answer(401))).toBe('signed-out');
    expect(await checkSession(answer(500))).toBe('error');
    expect(await checkSession(answer(200, { signed_in: 'yes' }))).toBe('error');
    expect(await checkSession(() => Promise.reject(new TypeError('offline')))).toBe('error');
  });

  it('signs out with a same-origin JSON POST', async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_: unknown, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    expect(await signOut(ok)).toBe(true);
    expect(seen).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
    expect(await signOut(answer(403))).toBe(false);
    expect(await signOut(() => Promise.reject(new TypeError('offline')))).toBe(false);
  });
});
