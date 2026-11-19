import { describe, expect, it } from 'vitest';
import { Drafting } from './drafting.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const P = '01900000-0000-7000-8000-0000000000a1';
const KEY = '0190a000-0000-4000-8000-000000000001';

function drafting(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const d = new Drafting(
    ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? json(500, {}));
    }) as typeof fetch,
    () => 'csrf-1',
  );
  return { d, calls };
}
const input = {
  treatment: { system: 'urn:endo:synthetic', code: 'SYNTH-DAILY' },
  dose_text: ' 1 daily ',
  start_date: '2026-11-15',
  review_interval_weeks: 12,
};

describe('REQ-002 clinic drafting logic', () => {
  it('reads the catalogue, sharing patients and a patient’s episodes, or null on failure', async () => {
    const { d, calls } = drafting([
      json(200, { draft: true, treatments: [] }),
      json(200, { patients: [{ id: P, enrolled_at: 'x' }] }),
      json(200, { episodes: [] }),
      json(500, {}),
      new TypeError('offline'),
    ]);
    expect(await d.catalogue()).toEqual({ draft: true, treatments: [] });
    expect(await d.patients()).toEqual([{ id: P, enrolled_at: 'x' }]);
    expect(await d.episodes(P)).toEqual([]);
    expect(calls[2]?.url).toBe(`/v1/patients/${P}/episodes`);
    expect(await d.patients()).toBeNull();
    expect(await d.episodes(P)).toBeNull();
  });

  it('drafts with CSRF and the Idempotency-Key; checks input before sending', async () => {
    const { d, calls } = drafting([
      json(201, {}),
      json(403, { type: 'https://e/authz.no_consent' }),
      json(502, {}),
      new TypeError('offline'),
      json(422, 'x'),
    ]);
    expect(await d.draft(P, input, KEY)).toEqual({ kind: 'drafted' });
    const h = new Headers(calls[0]?.init?.headers);
    expect(h.get('x-csrf-token')).toBe('csrf-1');
    expect(h.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({ dose_text: '1 daily' });
    expect(await d.draft(P, input, KEY)).toEqual({ kind: 'refused', code: 'authz.no_consent' });
    expect(await d.draft(P, input, KEY)).toEqual({ kind: 'error' });
    expect(await d.draft(P, input, KEY)).toEqual({ kind: 'error' });
    expect(await d.draft(P, input, KEY)).toEqual({ kind: 'refused', code: '' });
    const before = calls.length;
    for (const bad of [
      { ...input, dose_text: '  ' },
      { ...input, review_interval_weeks: 27 },
      { ...input, review_interval_weeks: 3 },
      { ...input, start_date: '15/11/2026' },
    ])
      expect(await d.draft(P, bad, KEY)).toEqual({
        kind: 'refused',
        code: 'episode.invalid_input',
      });
    expect(calls).toHaveLength(before);
  });
});
