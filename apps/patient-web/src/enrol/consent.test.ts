import { describe, expect, it } from 'vitest';
import { PURPOSES, VERSIONS, answer, text } from './consent.ts';

const NOW = new Date('2026-11-11T12:00:00Z');

describe('spec 13.1 consent: one purpose at a time, nothing shared by default', () => {
  it('asks all four in order and records each with its version and time', () => {
    let d = {};
    let done = false;
    for (const [i, p] of PURPOSES.entries()) {
      expect(done).toBe(false);
      const r = answer(d, p, i % 2 === 0 ? 'granted' : 'declined', NOW);
      d = r.decisions;
      done = r.done;
    }
    expect(done).toBe(true);
    expect(d).toEqual({
      self_tracking: {
        status: 'granted',
        version: VERSIONS.self_tracking,
        decided_at: NOW.toISOString(),
      },
      share_with_care_team: { status: 'declined', version: 1, decided_at: NOW.toISOString() },
      research_deidentified: { status: 'granted', version: 1, decided_at: NOW.toISOString() },
      org_aggregate_reporting: { status: 'declined', version: 1, decided_at: NOW.toISOString() },
    });
  });

  it('stops at once when she declines self-tracking, declining everything else', () => {
    const r = answer({}, 'self_tracking', 'declined', NOW);
    expect(r.done).toBe(true);
    expect(Object.values(r.decisions).every((x) => x.status === 'declined')).toBe(true);
    expect(Object.keys(r.decisions).sort()).toEqual([...PURPOSES].sort());
  });

  it('names a title, an explanation and two answers for every purpose', () => {
    for (const p of PURPOSES)
      for (const part of ['title', 'text', 'grant', 'decline'] as const)
        expect(text(p, part)).toBe(`consent.${p}.${part}`);
  });
});
