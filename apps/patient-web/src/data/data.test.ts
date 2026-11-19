import { describe, expect, it } from 'vitest';
import { cancelDeletion, deletionStatus, exportRecord, isReauth, requestDeletion } from './data.ts';

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const REAUTH = () => json(401, { type: 'https://errors.endo/authn.reauth_required' });
function fake(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? json(500);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('REQ-009 her data rights logic', () => {
  it('tells a fresh-sign-in refusal from any other', async () => {
    expect(await isReauth(REAUTH())).toBe(true);
    expect(await isReauth(json(401, { type: 'x/authn.session_required' }))).toBe(false);
    expect(await isReauth(json(403, { type: 'x/authn.reauth_required' }))).toBe(false);
    expect(await isReauth(new Response('not json', { status: 401 }))).toBe(false);
  });

  it('reads, asks for and cancels deletion', async () => {
    const scheduled = { status: 'scheduled', requested_at: 'a', due_at: 'b' };
    const { f, calls } = fake([
      json(200, { status: 'none' }),
      json(500),
      new TypeError('x'),
      json(202, scheduled),
      REAUTH(),
      json(500),
      new TypeError('x'),
      json(200, { ...scheduled, status: 'cancelled' }),
      json(409),
      new TypeError('x'),
    ]);
    expect(await deletionStatus(f)).toEqual({ status: 'none' });
    expect(await deletionStatus(f)).toBeNull();
    expect(await deletionStatus(f)).toBeNull();
    expect(await requestDeletion(f)).toEqual(scheduled);
    expect(calls[3]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(await requestDeletion(f)).toBe('reauth');
    expect(await requestDeletion(f)).toBe('error');
    expect(await requestDeletion(f)).toBe('error');
    expect(await cancelDeletion(f)).toMatchObject({ status: 'cancelled' });
    expect(calls[7]?.url).toBe('/v1/me/deletion/cancel');
    expect(await cancelDeletion(f)).toBe('error');
    expect(await cancelDeletion(f)).toBe('error');
  });

  it('downloads her record, or says she needs to sign in again', async () => {
    const { f, calls } = fake([
      new Response('{"resourceType":"Bundle"}', { status: 200 }),
      REAUTH(),
      json(502),
      new TypeError('x'),
    ]);
    const blob = await exportRecord(f);
    expect(blob).toBeInstanceOf(Blob);
    expect(await (blob as Blob).text()).toBe('{"resourceType":"Bundle"}');
    expect(calls[0]?.url).toBe('/v1/me/export');
    expect(await exportRecord(f)).toBe('reauth');
    expect(await exportRecord(f)).toBe('error');
    expect(await exportRecord(f)).toBe('error');
  });
});
