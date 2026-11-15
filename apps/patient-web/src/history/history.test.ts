import { describe, expect, it } from 'vitest';
import {
  accessLog,
  createShareLink,
  history,
  shareLinks,
  stopSharing,
  tokenFrom,
  viewShared,
} from './history.ts';

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const TOKEN = 'A'.repeat(43);
function fake(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? json(500);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('REQ-008 history and sharing logic', () => {
  it('reads history, links and the access log, or null', async () => {
    const { f } = fake([
      json(200, { treatments: [] }),
      json(200, { links: [{ id: 'l' }] }),
      json(200, { events: [] }),
      json(500),
      new TypeError('x'),
      json(500),
    ]);
    expect(await history(f)).toEqual({ treatments: [] });
    expect(await shareLinks(f)).toEqual([{ id: 'l' }]);
    expect(await accessLog(f)).toEqual([]);
    expect(await history(f)).toBeNull();
    expect(await shareLinks(f)).toBeNull();
    expect(await accessLog(f)).toBeNull();
  });

  it('puts the token in the fragment of the link, never in a path', async () => {
    const { f, calls } = fake([
      json(201, { token: TOKEN, expires_at: '2026-11-22T00:00:00Z' }),
      json(409),
      json(500),
      json(201, {}),
      new TypeError('x'),
    ]);
    expect(await createShareLink(f, 7, 'k', 'https://app.test')).toEqual({
      url: `https://app.test/shared#${TOKEN}`,
      expiresAt: '2026-11-22T00:00:00Z',
    });
    expect(new Headers(calls[0]?.init?.headers).get('idempotency-key')).toBe('k');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ days: 7 });
    expect(await createShareLink(f, 7, 'k', 'x')).toBe('already');
    expect(await createShareLink(f, 7, 'k', 'x')).toBe('error');
    expect(await createShareLink(f, 7, 'k', 'x')).toBe('error');
    expect(await createShareLink(f, 7, 'k', 'x')).toBe('error');
  });

  it('stops sharing', async () => {
    const { f, calls } = fake([new Response(null, { status: 204 }), json(500), new TypeError('x')]);
    expect(await stopSharing(f, 'id-1')).toBe(true);
    expect(calls[0]).toMatchObject({ url: '/v1/me/share-links/id-1', init: { method: 'DELETE' } });
    expect(await stopSharing(f, 'id-1')).toBe(false);
    expect(await stopSharing(f, 'id-1')).toBe(false);
  });

  it('reads the token from the fragment and shows the shared summary', async () => {
    expect(tokenFrom(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFrom('#short')).toBeNull();
    expect(tokenFrom('')).toBeNull();
    const { f, calls } = fake([
      json(200, { treatments: [] }),
      json(404),
      json(400),
      json(500),
      new TypeError('x'),
    ]);
    expect(await viewShared(f, TOKEN)).toEqual({ treatments: [] });
    expect(calls[0]?.init?.credentials).toBe('omit');
    expect(await viewShared(f, TOKEN)).toBe('invalid');
    expect(await viewShared(f, TOKEN)).toBe('invalid');
    expect(await viewShared(f, TOKEN)).toBe('error');
    expect(await viewShared(f, TOKEN)).toBe('error');
  });
});
