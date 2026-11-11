import { describe, expect, it } from 'vitest';
import { confirmEmailCode, requestEmailCode } from './email.ts';

const answer = (status: number, body: unknown = {}) =>
  (() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
const offline = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;

describe('REQ-001 ADR-0026 her email for the sign-in fallback', () => {
  it('asks for a code and keeps only the request id', async () => {
    let sent: RequestInit | undefined;
    const ok = (async (_: unknown, init?: RequestInit) => {
      sent = init;
      return Promise.resolve(new Response(JSON.stringify({ request_id: 'r1' }), { status: 202 }));
    }) as typeof fetch;
    expect(await requestEmailCode(ok, '  a@example.test ')).toBe('r1');
    expect(sent).toMatchObject({ method: 'POST', body: '{"address":"a@example.test"}' });
    expect(await requestEmailCode(answer(502), 'a@example.test')).toBe('error');
    expect(await requestEmailCode(answer(202, {}), 'a@example.test')).toBe('error');
    expect(await requestEmailCode(offline, 'a@example.test')).toBe('error');
  });

  it('confirms with the code, telling a wrong code from an outage', async () => {
    expect(await confirmEmailCode(answer(204), 'r1', ' 123456 ')).toBe('confirmed');
    expect(await confirmEmailCode(answer(400), 'r1', '123456')).toBe('wrong');
    expect(await confirmEmailCode(answer(502), 'r1', '123456')).toBe('error');
    expect(await confirmEmailCode(offline, 'r1', '123456')).toBe('error');
    // Not six digits: never sent.
    expect(await confirmEmailCode(offline, 'r1', '12a')).toBe('wrong');
  });
});
