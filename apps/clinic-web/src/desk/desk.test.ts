import { describe, expect, it } from 'vitest';
import { Desk, decisionKey, filterQueue, queueKey, type QueueRow } from './desk.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const P = '01900000-0000-7000-8000-0000000000a1';
const E = '01900000-0000-7000-8000-0000000000e5';
const KEY = '0190a000-0000-4000-8000-000000000001';

function desk(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const d = new Desk(
    ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? json(500, {}));
    }) as typeof fetch,
    () => 'csrf-1',
  );
  return { d, calls };
}
const row = (o: Partial<QueueRow>): QueueRow => ({
  episode_id: E,
  patient_id: P,
  treatment: { code: 'X', display: 'Synthetic daily tablet' },
  dose_text: '1',
  review_date: '2026-11-18',
  overdue: false,
  week: 12,
  check_ins: 10,
  red_flags: 0,
  ...o,
});

describe('REQ-005 spec 21.8 desk logic', () => {
  it('filters the queue: due this week, overdue, and search by pseudonym or treatment', () => {
    const rows = [
      row({}),
      row({ review_date: '2026-11-10', overdue: true }),
      row({ review_date: '2026-11-28', treatment: { code: 'D', display: 'Device' } }),
    ];
    expect(filterQueue(rows, 'all', '2026-11-15', '')).toHaveLength(3);
    expect(filterQueue(rows, 'this_week', '2026-11-15', '')).toEqual([rows[0]]);
    expect(filterQueue(rows, 'overdue', '2026-11-15', '')).toEqual([rows[1]]);
    expect(filterQueue(rows, 'all', '2026-11-15', 'device')).toEqual([rows[2]]);
    expect(filterQueue(rows, 'all', '2026-11-15', P.slice(-4))).toHaveLength(3);
  });

  it('moves with J/K, opens with Enter, chooses decisions with 1-5', () => {
    expect(queueKey('j', 0, 3)).toBe(1);
    expect(queueKey('j', 2, 3)).toBe(2);
    expect(queueKey('k', 0, 3)).toBe(0);
    expect(queueKey('ArrowUp', 2, 3)).toBe(1);
    expect(queueKey('ArrowDown', 0, 3)).toBe(1);
    expect(queueKey('Enter', 1, 3)).toBe('open');
    expect(queueKey('x', 1, 3)).toBeNull();
    expect(queueKey('j', 0, 0)).toBeNull();
    expect(decisionKey('1')).toBe('continue');
    expect(decisionKey('5')).toBe('stop');
    expect(decisionKey('6')).toBeNull();
    expect(decisionKey('a')).toBeNull();
  });

  it('reads the queue and a review, or null', async () => {
    const { d, calls } = desk([
      json(200, { items: [row({})] }),
      json(200, { episode: {} }),
      json(500, {}),
      new TypeError('x'),
    ]);
    expect((await d.queue())?.rows).toHaveLength(1);
    expect(await d.review(P, E)).toEqual({ episode: {} });
    expect(calls[1]?.url).toBe(`/v1/patients/${P}/episodes/${E}/review`);
    expect(await d.queue()).toBeNull();
    expect(await d.review(P, E)).toBeNull();
  });

  it('records a decision with CSRF and key, sending only what the decision needs', async () => {
    const { d, calls } = desk([
      json(201, { id: 'x' }),
      json(201, {}),
      json(409, { type: 'https://e/review.not_open' }),
      json(502, {}),
      new TypeError('x'),
      json(422, 'x'),
    ]);
    const choice = {
      treatment: { system: 's', code: 'c' },
      dose_text: 'd',
      start_date: '2026-11-20',
      review_interval_weeks: 12,
    };
    expect(
      await d.decide(P, E, 'switch', '  a note ', { next: choice, added: choice }, KEY),
    ).toEqual({ kind: 'ok', body: { id: 'x' } });
    const h = new Headers(calls[0]?.init?.headers);
    expect(h.get('x-csrf-token')).toBe('csrf-1');
    expect(h.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      decision: 'switch',
      note: 'a note',
      next: choice,
    });
    await d.decide(P, E, 'add', '', { added: choice }, KEY);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({ decision: 'add', added: choice });
    expect(await d.decide(P, E, 'stop', '', {}, KEY)).toEqual({
      kind: 'refused',
      code: 'review.not_open',
    });
    expect(await d.decide(P, E, 'stop', '', {}, KEY)).toEqual({ kind: 'error' });
    expect(await d.decide(P, E, 'stop', '', {}, KEY)).toEqual({ kind: 'error' });
    expect(await d.decide(P, E, 'stop', '', {}, KEY)).toEqual({ kind: 'refused', code: '' });
  });

  it('previews and records a pre-surgery check, the record only as discussed', async () => {
    const { d, calls } = desk([json(200, { procedure: 'ablation' }), json(201, { id: 'c' })]);
    expect(await d.surgeryPreview(P, 'ablation', KEY)).toEqual({
      kind: 'ok',
      body: { procedure: 'ablation' },
    });
    expect(await d.surgeryRecord(P, 'ablation', 'a'.repeat(64), KEY)).toMatchObject({
      kind: 'ok',
    });
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      procedure: 'ablation',
      discussed_with_patient: true,
      snapshot_hash: 'a'.repeat(64),
    });
  });
});
