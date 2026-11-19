/**
 * The Trial Strip's data (spec 21.6): one column per week of the trial, four lanes. Pure: the
 * React component draws it as SVG with an equivalent table for screen readers.
 *
 * - Benefit: worst pain (Q1) drawn against the first week with an answer (the baseline rule);
 *   the goal (Q3) as filled, half or empty.
 * - Side effects: how much they bothered her (Q6), as a weight 0 to 3.
 * - Taken: days taken (Q7, 0 to 7), or for devices and injections still in place / given.
 * - Barriers: what got in the way (Q8), as codes.
 * - A week without a check-in is "no entry": never blank and never zero.
 */
export interface WeekAnswers {
  readonly Q1?: number;
  readonly Q3?: string;
  readonly Q5?: readonly string[];
  readonly Q6?: string;
  readonly Q7?: number | string;
  readonly Q8?: readonly string[];
}

export type StripWeek =
  | { readonly week: number; readonly entry: false; readonly review: boolean }
  | {
      readonly week: number;
      readonly entry: true;
      readonly review: boolean;
      /** Worst pain 0 to 10, or null when not answered. */
      readonly pain: number | null;
      /** Pain relative to the baseline week: positive is better (less pain). */
      readonly change: number | null;
      readonly goal: 'met' | 'partly' | 'not_met' | 'not_applicable' | null;
      readonly sideEffects: 0 | 1 | 2 | 3 | null;
      /** Days taken (0 to 7), or 7 / 0 for device or injection yes / no. */
      readonly taken: number | null;
      readonly barriers: readonly string[];
      readonly late: boolean;
    };

export interface StripModel {
  readonly weeks: readonly StripWeek[];
  /** Pain in the baseline week (the first answered), or null. */
  readonly baseline: number | null;
}

const BOTHER: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  not_at_all: 0,
  a_little: 1,
  a_lot: 2,
  unbearable: 3,
};
const GOAL: Readonly<Record<string, 'met' | 'partly' | 'not_met' | 'not_applicable'>> = {
  yes: 'met',
  partly: 'partly',
  no: 'not_met',
  did_not_apply: 'not_applicable',
};

export function stripModel(
  totalWeeks: number,
  checkIns: readonly {
    readonly week_index: number;
    readonly is_late?: boolean;
    readonly answers: unknown;
  }[],
  reviewWeek: number = totalWeeks,
): StripModel {
  const byWeek = new Map(checkIns.map((c) => [c.week_index, c]));
  const firstPain = [...checkIns]
    .sort((a, b) => a.week_index - b.week_index)
    .map((c) => (c.answers as WeekAnswers | null)?.Q1)
    .find((p): p is number => typeof p === 'number');
  const baseline = firstPain ?? null;
  const weeks: StripWeek[] = [];
  for (let week = 1; week <= totalWeeks; week++) {
    const c = byWeek.get(week);
    const review = week === reviewWeek;
    if (!c) {
      weeks.push({ week, entry: false, review });
      continue;
    }
    const a = (c.answers ?? {}) as WeekAnswers;
    const pain = typeof a.Q1 === 'number' ? a.Q1 : null;
    const bother = typeof a.Q6 === 'string' ? new Map(Object.entries(BOTHER)).get(a.Q6) : undefined;
    const goal = typeof a.Q3 === 'string' ? new Map(Object.entries(GOAL)).get(a.Q3) : undefined;
    const taken = typeof a.Q7 === 'number' ? a.Q7 : a.Q7 === 'yes' ? 7 : a.Q7 === 'no' ? 0 : null;
    weeks.push({
      week,
      entry: true,
      review,
      pain,
      change: pain !== null && baseline !== null ? baseline - pain : null,
      goal: goal ?? null,
      // No side effect reported: weight 0. Not answered at all: null.
      sideEffects: bother ?? (Array.isArray(a.Q5) ? 0 : null),
      taken,
      barriers: (a.Q8 ?? []).filter((b) => b !== 'none'),
      late: c.is_late === true,
    });
  }
  return { weeks, baseline };
}

/** Plain-language row for the screen-reader table (and the print view). */
export function describeWeek(w: StripWeek): readonly string[] {
  if (!w.entry) return [`Week ${String(w.week)}`, 'No entry', '', '', ''];
  return [
    `Week ${String(w.week)}${w.late ? ' (late)' : ''}`,
    w.pain === null
      ? 'Pain not answered'
      : `Worst pain ${String(w.pain)} of 10${w.goal ? `, goal ${w.goal.replace('_', ' ')}` : ''}`,
    w.sideEffects === null
      ? 'Not answered'
      : (['None', 'A little', 'A lot', 'Unbearable'].at(w.sideEffects) ?? ''),
    w.taken === null ? 'Not answered' : `${String(w.taken)} of 7 days`,
    w.barriers.length ? w.barriers.map((b) => b.replace(/_/g, ' ')).join(', ') : 'None',
  ];
}
