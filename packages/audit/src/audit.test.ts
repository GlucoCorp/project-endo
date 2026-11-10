import { describe, expect, it } from 'vitest';
import {
  AuditSequenceConflictError,
  AuditWriter,
  GENESIS_HASH,
  InMemoryAuditStore,
  verifyChain,
  type AuditEvent,
  type AuditEventInputType,
} from './index.ts';

const REQ = '01900000-0000-7000-8000-00000000000f';
const ACTOR = '01900000-0000-7000-8000-000000000001';

function input(overrides: Partial<AuditEventInputType> = {}): AuditEventInputType {
  return {
    actor: { id: ACTOR, role: 'clinician' },
    action: 'episode.read',
    resource: { type: 'treatment_episode', id: '01900000-0000-7000-8000-0000000000aa' },
    org_id: '01900000-0000-7000-8000-0000000000bb',
    purpose_of_use: 'treatment',
    outcome: 'success',
    reason: null,
    request_id: REQ,
    ...overrides,
  };
}

async function writeN(n: number) {
  const store = new InMemoryAuditStore();
  const writer = new AuditWriter(store, () => new Date('2026-11-07T10:00:00Z'));
  for (let i = 0; i < n; i++) await writer.write(input());
  return { store, writer, events: await store.readRange(1, 1000) };
}

describe('RISK-R01 hash-chained audit log (spec 12.9)', () => {
  it('chains events from the genesis hash', async () => {
    const { events } = await writeN(3);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(events[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(events[1]!.prev_hash).toBe(events[0]!.hash);
    expect(verifyChain(events)).toEqual({ ok: true, count: 3, headHash: events[2]!.hash });
  });

  it('serialises concurrent writes into one valid chain', async () => {
    const store = new InMemoryAuditStore();
    const writer = new AuditWriter(store);
    await Promise.all(Array.from({ length: 50 }, () => writer.write(input())));
    const events = await store.readRange(1, 100);
    expect(events).toHaveLength(50);
    expect(verifyChain(events).ok).toBe(true);
  });

  it('detects a modified field', async () => {
    const { events } = await writeN(3);
    const tampered: AuditEvent[] = events.map((e) => ({ ...e }));
    tampered[1] = { ...tampered[1]!, outcome: 'denied' };
    expect(verifyChain(tampered)).toEqual({ ok: false, brokenAtSequence: 2, reason: 'hash' });
  });

  it('detects a deleted event', async () => {
    const { events } = await writeN(3);
    expect(verifyChain([events[0]!, events[2]!])).toMatchObject({ ok: false, reason: 'sequence' });
  });

  it('detects a broken link even if hashes are recomputed', async () => {
    const { events } = await writeN(2);
    expect(verifyChain(events.slice(1), 'f'.repeat(64))).toMatchObject({
      ok: false,
      reason: 'link',
    });
  });

  it('verifies a later range from an anchor hash', async () => {
    const { events } = await writeN(4);
    expect(verifyChain(events.slice(2), events[1]!.hash).ok).toBe(true);
  });

  it('an empty range is trivially valid', () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, headHash: GENESIS_HASH });
  });

  it('store rejects out-of-order appends', async () => {
    const { store, events } = await writeN(1);
    await expect(store.append({ ...events[0]!, sequence: 5 })).rejects.toThrow(/sequence/);
  });

  it('stored events are immutable', async () => {
    const { events } = await writeN(1);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('a failed append does not poison later writes', async () => {
    const store = new InMemoryAuditStore();
    let fail = true;
    const append = (e: AuditEvent) =>
      fail ? Promise.reject(new Error('db down')) : store.append(e);
    const flaky = {
      head: () => store.head(),
      readRange: (a: number, b: number) => store.readRange(a, b),
      append,
      appendNext: async (build: (head: AuditEvent | null) => AuditEvent) => {
        const e = build(await store.head());
        await append(e);
        return e;
      },
    };
    const writer = new AuditWriter(flaky);
    await expect(writer.write(input())).rejects.toThrow('db down');
    fail = false;
    await expect(writer.write(input())).resolves.toMatchObject({ sequence: 1 });
  });
});

describe('RISK-I02 no content in audit events', () => {
  it.each([
    ['free text in action', { action: 'patient said her pain is 9' }],
    ['email in actor id', { actor: { id: 'jane@example.com', role: 'patient' as const } }],
    ['unknown role', { actor: { id: ACTOR, role: 'doctor' as never } }],
    ['name in resource type', { resource: { type: 'Jane Doe', id: null } }],
    ['sentence as reason', { reason: 'consent was revoked by Jane' }],
  ])('rejects %s', async (_label, bad) => {
    const writer = new AuditWriter(new InMemoryAuditStore());
    await expect(writer.write(input(bad as Partial<AuditEventInputType>))).rejects.toThrow();
  });

  it('rejects unknown fields', async () => {
    const writer = new AuditWriter(new InMemoryAuditStore());
    const withNote = { ...input(), note: 'pain 9/10' } as AuditEventInputType;
    await expect(writer.write(withNote)).rejects.toThrow();
  });

  it('accepts anonymous and system actors', async () => {
    const writer = new AuditWriter(new InMemoryAuditStore());
    await expect(
      writer.write(
        input({
          actor: { id: null, role: 'anonymous' },
          outcome: 'denied',
          reason: 'authn.missing',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'denied' });
  });
});

describe('cross-process sequence conflicts', () => {
  function racingStore(conflicts: number) {
    const store = new InMemoryAuditStore();
    let remaining = conflicts;
    // A writer outside the exclusive lock (e.g. an older version) keeps winning the race.
    const append = (e: AuditEvent) =>
      remaining-- > 0 ? Promise.reject(new AuditSequenceConflictError()) : store.append(e);
    return {
      head: () => store.head(),
      readRange: (a: number, b: number) => store.readRange(a, b),
      append,
      appendNext: async (build: (head: AuditEvent | null) => AuditEvent) => {
        const e = build(await store.head());
        await append(e);
        return e;
      },
      store,
    };
  }

  it('rebuilds the event on the new head and retries', async () => {
    const s = racingStore(2);
    const event = await new AuditWriter(s).write(input());
    expect(event.sequence).toBe(1);
    expect(verifyChain(await s.store.readRange(1, 10)).ok).toBe(true);
  });

  it('gives up after repeated conflicts rather than looping forever', async () => {
    const s = racingStore(100);
    await expect(new AuditWriter(s).write(input())).rejects.toBeInstanceOf(
      AuditSequenceConflictError,
    );
  });
});

describe('spec 2.6 events relayed from an outbox keep their original time', () => {
  it('records occurredAt, still chains, and refuses a future time', async () => {
    const store = new InMemoryAuditStore();
    const now = new Date('2026-11-08T12:00:00Z');
    const writer = new AuditWriter(store, () => now);
    const earlier = new Date('2026-11-08T11:00:00Z');
    const e = await writer.write(input(), earlier);
    expect(e.occurred_at).toBe(earlier.toISOString());
    expect(verifyChain(await store.readRange(1, 10)).ok).toBe(true);
    await expect(writer.write(input(), new Date('2026-11-08T13:00:00Z'))).rejects.toThrow(
      RangeError,
    );
  });
});
