import { describe, expect, it } from 'vitest';
import { redFlagKeyFor } from '@endo/domain';
import { deviceTimeZone, getJson, paths, send, type CheckInContent } from './api.ts';
import {
  answered,
  daysUntil,
  nextStep,
  previousStep,
  progress,
  stepsFor,
  toSubmission,
  today,
  toggle,
  weekOf,
} from './flow.ts';
import type { Answers } from './flow.ts';
import { MemoryQueueStorage, OfflineQueue, type QueueItem } from './queue.ts';
import { flush, reportRedFlags, submitWeek } from './submit.ts';

const MARKER = 'SYNTHETIC_PHI_MARKER-7f3a';
const EP = '01900000-0000-7000-8000-0000000000e5';
const KEY = '0190a000-0000-4000-8000-000000000001';
const content: CheckInContent = {
  draft: true,
  instrument_version: '1.0.0',
  text: {},
  options: { Q2: ['none'], Q3: ['yes'], Q5: ['a', 'b'], Q6: ['a_lot'], Q8: ['none', 'cost'] },
  review_weeks: [4, 8, 12],
  red_flags: [{ id: 'RF1', text: 'x', routes_to: null }],
  goals: [],
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses.shift() ?? new Response('{}', { status: 200 });
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const A = (o: Record<string, unknown>) => new Map(Object.entries(o)) as Answers;
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe('REQ-003 spec 6 check-in screens', () => {
  it('starts with red flags, asks Q6 only after a side effect, adds GIC on review weeks', () => {
    expect(stepsFor(content, 1, A({}))).toEqual([
      'red_flags',
      'Q1',
      'Q2',
      'Q3',
      'Q5',
      'Q7',
      'Q8',
      'review',
    ]);
    expect(stepsFor(content, 4, A({ Q5: ['a'] }))).toEqual([
      'red_flags',
      'Q1',
      'Q2',
      'Q3',
      'Q5',
      'Q6',
      'Q7',
      'Q8',
      'GIC',
      'review',
    ]);
    expect(nextStep(content, 1, A({}), 'Q5')).toBe('Q7');
    expect(nextStep(content, 1, A({ Q5: ['b'] }), 'Q5')).toBe('Q6');
    expect(nextStep(content, 1, A({}), 'review')).toBe('review');
    expect(previousStep(content, 1, A({}), 'red_flags')).toBeNull();
    expect(previousStep(content, 1, A({}), 'Q1')).toBe('red_flags');
    expect(progress(content, 1, A({}), 'Q2')).toEqual({ index: 3, total: 7 });
  });

  it('knows when a screen is answered, and submits only what was asked', () => {
    expect(answered('red_flags', A({}))).toBe(false);
    expect(answered('red_flags', A({ red_flags: [] }))).toBe(true);
    expect(answered('Q8', A({ Q8: [] }))).toBe(false);
    expect(answered('Q1', A({ Q1: 0 }))).toBe(true);
    expect(answered('review', A({}))).toBe(true);
    // Q6 was answered, then she removed her side effects: Q6 is not sent.
    expect(
      toSubmission(content, 1, A({ red_flags: [], Q1: 3, Q5: [], Q6: 'a_lot', Q8: ['none'] })),
    ).toEqual({
      red_flags: [],
      Q1: 3,
      Q5: [],
      Q8: ['none'],
    });
  });

  it('keeps "none" exclusive in multi-selects', () => {
    expect(toggle(undefined, 'cost', 'none')).toEqual(['cost']);
    expect(toggle(['cost'], 'none', 'none')).toEqual(['none']);
    expect(toggle(['none'], 'cost', 'none')).toEqual(['cost']);
    expect(toggle(['cost'], 'cost', 'none')).toEqual([]);
    expect(toggle(['a'], 'b', null)).toEqual(['a', 'b']);
  });

  it('counts days and weeks on her calendar', () => {
    expect(daysUntil('2026-11-15', '2026-11-20')).toBe(5);
    expect(daysUntil('2026-11-25', '2026-11-20')).toBe(0);
    expect(weekOf('2026-11-15', '2026-11-15', 12)).toBe(1);
    expect(weekOf('2026-11-22', '2026-11-15', 12)).toBe(2);
    expect(weekOf('2027-06-01', '2026-11-15', 12)).toBe(12);
    expect(weekOf('2026-11-01', '2026-11-15', 12)).toBe(1);
    expect(today(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(deviceTimeZone()).toMatch(/\w/);
  });
});

describe('REQ-003 API calls classify outcomes for retries', () => {
  it('sends JSON with the Idempotency-Key and classifies every outcome', async () => {
    const { f, calls } = fakeFetch([
      json(201, { id: 'x' }),
      json(401),
      json(409, { type: 'https://e/checkin.too_late' }),
      json(503),
      new TypeError('offline'),
      json(422, 'not json'),
    ]);
    expect(await send(f, paths.checkIn(EP), KEY, { a: 1 })).toEqual({
      kind: 'ok',
      body: { id: 'x' },
    });
    expect(new Headers(calls[0]?.init.headers).get('idempotency-key')).toBe(KEY);
    expect(calls[0]?.url).toBe(`/v1/episodes/${EP}/checkins`);
    expect(await send(f, '/x', KEY, {})).toEqual({ kind: 'signed-out' });
    expect(await send(f, '/x', KEY, {})).toEqual({ kind: 'refused', code: 'checkin.too_late' });
    expect(await send(f, '/x', KEY, {})).toEqual({ kind: 'offline' });
    expect(await send(f, '/x', KEY, {})).toEqual({ kind: 'offline' });
    expect(await send(f, '/x', KEY, {})).toEqual({ kind: 'refused', code: '' });
  });

  it('reads JSON, or says signed out, or null', async () => {
    const { f } = fakeFetch([json(200, { a: 1 }), json(401), json(500), new TypeError('x')]);
    expect(await getJson(f, paths.episodes)).toEqual({ a: 1 });
    expect(await getJson(f, paths.content)).toBe('signed-out');
    expect(await getJson(f, paths.content)).toBeNull();
    expect(await getJson(f, paths.content)).toBeNull();
    expect(paths.confirm(EP)).toBe(`/v1/episodes/${EP}/confirm`);
  });
});

describe('REQ-003 spec 14 encrypted offline queue', () => {
  const item = (kind: QueueItem['kind'], body: unknown = { marker: MARKER }): QueueItem => ({
    kind,
    url: '/x',
    key: KEY,
    body,
    createdAt: new Date().toISOString(),
  });

  it('stores entries encrypted with a non-extractable key, and sends red flags first', async () => {
    const storage = new MemoryQueueStorage();
    const q = new OfflineQueue(storage);
    await q.add(item('checkin'));
    await q.add(item('red_flags'));
    const key = await storage.getKey();
    expect(key?.extractable).toBe(false);
    const stored = await storage.list();
    expect(new TextDecoder().decode(stored[0]?.data)).not.toContain(MARKER);
    const order: string[] = [];
    const r = await q.drain((i) => {
      order.push(i.kind);
      return Promise.resolve({ kind: 'ok', body: {} });
    });
    expect(order).toEqual(['red_flags', 'checkin']);
    expect(r).toEqual({ sent: 2, refused: 0, remaining: 0, stopped: null });
    expect(await q.size()).toBe(0);
  });

  it('keeps the rest when offline or signed out; drops what was refused for good', async () => {
    const q = new OfflineQueue(new MemoryQueueStorage());
    await q.add(item('checkin'));
    await q.add(item('checkin'));
    expect(await q.drain(() => Promise.resolve({ kind: 'offline' }))).toMatchObject({
      stopped: 'offline',
      remaining: 2,
    });
    expect(await q.drain(() => Promise.resolve({ kind: 'refused', code: 'x' }))).toMatchObject({
      refused: 2,
    });
    expect(await q.size()).toBe(0);
  });

  it('runs one drain at a time', async () => {
    const q = new OfflineQueue(new MemoryQueueStorage());
    await q.add(item('checkin'));
    let sends = 0;
    const slow = () => {
      sends++;
      return new Promise<{ kind: 'ok'; body: Record<string, unknown> }>((r) => {
        setTimeout(() => {
          r({ kind: 'ok', body: {} });
        }, 20);
      });
    };
    const [a, b] = await Promise.all([q.drain(slow), q.drain(slow)]);
    expect(a).toBe(b);
    expect(sends).toBe(1);
  });

  it('destroys the key and entries on clear; entries under another key are dropped unread', async () => {
    const storage = new MemoryQueueStorage();
    const q = new OfflineQueue(storage);
    await q.add(item('checkin'));
    const [entry] = await storage.list();
    await q.clear();
    expect(await storage.getKey()).toBeNull();
    expect(await q.size()).toBe(0);
    // An entry from an old session (its key gone, or a new key now): never sent, deleted.
    if (entry) await storage.put(entry);
    let sent = 0;
    await q.drain(() => {
      sent++;
      return Promise.resolve({ kind: 'ok', body: {} });
    });
    expect(sent).toBe(0);
    expect(await q.size()).toBe(0);
    await q.add(item('checkin'));
    if (entry) await storage.put(entry);
    await q.drain(() => {
      sent++;
      return Promise.resolve({ kind: 'ok', body: {} });
    });
    expect(sent).toBe(1);
  });
});

describe('REQ-007 red flags first, then the week', () => {
  it('reports red flags under the key derived from the check-in key', async () => {
    const { f, calls } = fakeFetch([json(201)]);
    const q = new OfflineQueue(new MemoryQueueStorage());
    const r = await reportRedFlags(f, q, EP, KEY, ['RF3', 'RF1'], new Date(1000), new Date(2000));
    expect(r).toBe('ok');
    expect(new Headers(calls[0]?.init.headers).get('idempotency-key')).toBe(
      await redFlagKeyFor(KEY, ['RF1', 'RF3']),
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      flags: ['RF1', 'RF3'],
      shown_at: new Date(1000).toISOString(),
      acknowledged_at: new Date(2000).toISOString(),
    });
  });

  it('queues red flags offline, and sends them before the week when back online', async () => {
    const q = new OfflineQueue(new MemoryQueueStorage());
    const off = fakeFetch([new TypeError('offline')]);
    expect(await reportRedFlags(off.f, q, EP, KEY, ['RF1'], new Date(), null)).toBe('queued');
    const on = fakeFetch([json(201), json(201, { open_weeks: [2] })]);
    expect(await submitWeek(on.f, q, EP, KEY, 1, { Q1: 1 }, new Date())).toEqual({
      kind: 'saved',
      openWeeks: [2],
    });
    expect(on.calls.map((c) => c.url)).toEqual([paths.redFlags(EP), paths.checkIn(EP)]);
    expect(await q.size()).toBe(0);
  });

  it('queues the week offline or signed out; reports a refusal', async () => {
    const q = new OfflineQueue(new MemoryQueueStorage());
    expect(await submitWeek(fakeFetch([new TypeError('x')]).f, q, EP, KEY, 1, {}, null)).toEqual({
      kind: 'queued',
    });
    expect(
      await submitWeek(fakeFetch([new TypeError('x'), json(401)]).f, q, EP, KEY, 1, {}, null),
    ).toEqual({ kind: 'signed-out' });
    expect(await q.size()).toBe(2);
    const refused = await submitWeek(
      fakeFetch([json(200), json(200), json(409, { type: 'https://e/checkin.week_done' })]).f,
      q,
      EP,
      KEY,
      1,
      {},
      null,
    );
    expect(refused).toEqual({ kind: 'refused', code: 'checkin.week_done' });
    expect(await q.size()).toBe(0);
    expect(await submitWeek(fakeFetch([json(201, {})]).f, q, EP, KEY, 1, {}, null)).toEqual({
      kind: 'saved',
      openWeeks: [],
    });
    expect(await flush(fakeFetch([]).f, q)).toMatchObject({ sent: 0 });
    expect(
      await reportRedFlags(fakeFetch([json(422)]).f, q, EP, KEY, ['RF1'], new Date(), null),
    ).toBe('refused');
  });
});
