import { describe, expect, it } from 'vitest';
import { bucketCounts, monthsBack } from './reporting.ts';

describe('REQ-011 monthly buckets', () => {
  it('counts starts and reviews per month, on time within the grace days', () => {
    const rows = bucketCounts(
      [
        new Date('2026-11-03T10:00:00Z'),
        new Date('2026-10-30T10:00:00Z'),
        null,
        new Date('2025-01-01T00:00:00Z'),
      ],
      [
        { review_date: '2026-10-10', decided_at: new Date('2026-10-17T23:59:00Z') }, // day 7: on time
        { review_date: '2026-10-10', decided_at: new Date('2026-10-18T00:00:00Z') }, // day 8: late
        { review_date: '2026-11-01', decided_at: null }, // not decided
        { review_date: '2024-01-01', decided_at: null }, // outside the window
      ],
      '2026-11-16',
      2,
      7,
    );
    expect(rows).toEqual([
      { month: '2026-10-01', episodesStarted: 1, reviewsDue: 2, reviewsOnTime: 1 },
      { month: '2026-11-01', episodesStarted: 1, reviewsDue: 1, reviewsOnTime: 0 },
    ]);
  });

  it('steps back across years', () => {
    expect(monthsBack('2026-01-15', 1)).toBe('2025-12-01');
    expect(monthsBack('2026-03-31', 14)).toBe('2025-01-01');
  });
});
