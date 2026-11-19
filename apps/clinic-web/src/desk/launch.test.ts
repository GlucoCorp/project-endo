import { describe, expect, it } from 'vitest';
import { launchContext, launchHandle, linkLaunch } from './launch.ts';

const H = 'h'.repeat(43);
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
function fake(answers: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift() ?? json(500);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('M7 opened from a record system', () => {
  it('reads the launch handle from the fragment only', () => {
    expect(launchHandle(`#launch=${H}`)).toBe(H);
    expect(launchHandle('#launch=short')).toBeNull();
    expect(launchHandle('')).toBeNull();
  });

  it('asks which patient the launch is for', async () => {
    const { f, calls } = fake([
      json(200, { linked: true, patient_id: 'p' }),
      json(200, { linked: false }),
      json(404),
      json(403),
      new TypeError('x'),
    ]);
    expect(await launchContext(f, 'csrf', H)).toEqual({ linked: true, patient_id: 'p' });
    expect(new Headers(calls[0]?.init?.headers).get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ handle: H });
    expect(await launchContext(f, 'csrf', H)).toEqual({ linked: false });
    expect(await launchContext(f, 'csrf', H)).toBe('expired');
    expect(await launchContext(f, 'csrf', H)).toBe('error');
    expect(await launchContext(f, 'csrf', H)).toBe('error');
  });

  it('links it once', async () => {
    const { f, calls } = fake([json(201), json(409), json(404), json(403), new TypeError('x')]);
    expect(await linkLaunch(f, 'c', H, 'p')).toBe('linked');
    expect(calls[0]?.url).toBe('/v1/smart/link');
    expect(await linkLaunch(f, 'c', H, 'p')).toBe('exists');
    expect(await linkLaunch(f, 'c', H, 'p')).toBe('expired');
    expect(await linkLaunch(f, 'c', H, 'p')).toBe('error');
    expect(await linkLaunch(f, 'c', H, 'p')).toBe('error');
  });
});
