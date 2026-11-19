import { describe, expect, it } from 'vitest';
import { describeWeek, stripModel } from './model.ts';

describe('spec 21.6 Trial Strip model', () => {
  const weeks = [
    { week_index: 1, answers: { Q1: 8, Q3: 'no', Q5: [], Q7: 7, Q8: ['none'] } },
    {
      week_index: 2,
      is_late: true,
      answers: { Q1: 5, Q3: 'partly', Q5: ['x'], Q6: 'a_lot', Q7: 5, Q8: ['cost', 'ran_out'] },
    },
    { week_index: 4, answers: { Q1: 3, Q3: 'yes', Q7: 'yes' } },
    { week_index: 5, answers: { Q3: 'did_not_apply', Q7: 'no', Q6: 'unbearable' } },
  ];

  it('places each week, marks missing weeks as no entry, and compares pain with the first week', () => {
    const m = stripModel(6, weeks, 6);
    expect(m.baseline).toBe(8);
    expect(m.weeks).toHaveLength(6);
    expect(m.weeks[2]).toEqual({ week: 3, entry: false, review: false });
    expect(m.weeks[5]).toEqual({ week: 6, entry: false, review: true });
    expect(m.weeks[0]).toMatchObject({
      pain: 8,
      change: 0,
      goal: 'not_met',
      sideEffects: 0,
      taken: 7,
      barriers: [],
    });
    expect(m.weeks[1]).toMatchObject({
      change: 3,
      goal: 'partly',
      sideEffects: 2,
      taken: 5,
      barriers: ['cost', 'ran_out'],
      late: true,
    });
    expect(m.weeks[3]).toMatchObject({ change: 5, goal: 'met', taken: 7, sideEffects: null });
    expect(m.weeks[4]).toMatchObject({
      pain: null,
      change: null,
      goal: 'not_applicable',
      taken: 0,
      sideEffects: 3,
    });
  });

  it('has no baseline when no week has pain, and describes every week in words', () => {
    const m = stripModel(2, [{ week_index: 2, answers: {} }]);
    expect(m.baseline).toBeNull();
    expect(m.weeks[1]).toMatchObject({
      pain: null,
      change: null,
      goal: null,
      taken: null,
      sideEffects: null,
    });
    expect(describeWeek(m.weeks[0] ?? { week: 1, entry: false, review: false })).toEqual([
      'Week 1',
      'No entry',
      '',
      '',
      '',
    ]);
    expect(describeWeek(m.weeks[1] ?? { week: 2, entry: false, review: false })).toEqual([
      'Week 2',
      'Pain not answered',
      'Not answered',
      'Not answered',
      'None',
    ]);
    const full = stripModel(2, weeks).weeks[1];
    expect(full && describeWeek(full)).toEqual([
      'Week 2 (late)',
      'Worst pain 5 of 10, goal partly',
      'A lot',
      '5 of 7 days',
      'cost, ran out',
    ]);
    expect(stripModel(1, [{ week_index: 1, answers: null }]).weeks[0]).toMatchObject({
      entry: true,
      pain: null,
    });
  });
});
