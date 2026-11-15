/**
 * The verdict rule set (spec 7.3): every number and every choice the engine uses comes from here,
 * set and signed off by the clinical lead. Nothing has a default. `parseRuleset` lists everything
 * that is missing or still `TODO_CLINICAL`; the engine runs only on a complete rule set.
 *
 * Where spec 7.2 leaves a step undefined (Section 24 items 25 to 27), the rule set must choose
 * among explicit, generic options (an aggregate, how a "partly" counts, whether "didn't apply"
 * weeks count), so the clinical decision stays with the clinical lead.
 */
export interface Ruleset {
  readonly version: string;
  readonly approvedBy: string;
  readonly approvedOn: string;
  /**
   * The definitions the engine implements, each named so the clinical lead chooses it explicitly
   * in the signed rule set (review 2026-11-15; Section 24 items 25 to 27). Each has one option
   * today, documented in the package README; another definition is a code change plus a new name.
   */
  readonly definitions: {
    /** Which check-ins count toward min_checkins: every submitted one. */
    readonly validity: 'any_submitted';
    /** Daily adherence: days taken over 7 per week answered; unanswered weeks are left out. */
    readonly adherence_daily: 'answered_weeks';
    /** Intolerance: weeks with Q6 "unbearable"; no stop question exists yet. */
    readonly intolerance: 'unbearable_weeks';
    /**
     * Benefit: worst pain (Q1) aggregated over the first and last weeks of the episode (windows
     * must not overlap; missing weeks left out); goal share over all submitted weeks; no Q2.
     */
    readonly benefit: 'q1_first_last_windows';
    /**
     * Modifiers: SIDE_EFFECTS_LIMITING = weeks with Q6 "a lot" or "unbearable"; BARRIER_COST and
     * BARRIER_STOCKOUT = share of submitted weeks naming cost or ran_out (Q8); DATA_GAPS =
     * missing weeks.
     */
    readonly modifiers: 'v1';
    /** No eligible goal weeks counts as the goal not met. */
    readonly empty_goal: 'not_met';
  };
  /** Fewest Q1 answers needed in each benefit window. */
  readonly min_values_per_window: number;
  readonly thresholds: {
    /** Fewest submitted check-ins to judge at all. */
    readonly min_checkins: number;
    /** Lowest adherence ratio (0 to 1) to judge benefit. */
    readonly adherence_threshold: number;
    /** Weeks rated "unbearable" (Q6) that make it not tolerated. */
    readonly intolerance_weeks: number;
    /** First weeks of the episode compared with its last weeks. */
    readonly baseline_window_weeks: number;
    readonly recent_window_weeks: number;
    /** Worst-pain (Q1) reduction that counts as meaningful. */
    readonly meaningful_improvement: {
      readonly absolute_points: number;
      /** 0 to 1, of the baseline value. */
      readonly relative: number;
      readonly combine: 'either' | 'both';
    };
    /** Worst-pain reduction (points) above which there is some benefit. */
    readonly minimal_change: number;
    /** Share of weeks with the goal met (0 to 1). */
    readonly goal_met_threshold: number;
  };
  readonly benefit: {
    /** How a window's weekly Q1 values become one number. */
    readonly aggregate: 'mean' | 'median' | 'max';
  };
  readonly goal: {
    /** What a "partly" (Q3) counts for, 0 to 1. */
    readonly partly_counts_as: number;
    /** Whether "didn't apply this week" weeks are left out of the share. */
    readonly exclude_did_not_apply: boolean;
  };
  readonly adherence: {
    /** Devices and injections have no day count: the share of weeks answered "yes". */
    readonly device_or_injection: 'share_of_yes';
  };
  readonly modifiers: {
    /** Weeks rated "a lot" or "unbearable" that make side effects limiting. */
    readonly side_effects_limiting_weeks: number;
    /** Share of submitted weeks (0 to 1) naming cost (BARRIER_COST) or running out (STOCKOUT). */
    readonly barrier_share: number;
    /** Missing weeks that make DATA_GAPS. */
    readonly data_gaps_missing_weeks: number;
  };
}

export type RulesetCheck =
  | { readonly ok: true; readonly ruleset: Ruleset }
  | { readonly ok: false; readonly missing: readonly string[] };

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Checks a parsed rule set file. Lists every missing, `TODO_CLINICAL` or out-of-range value. */
export function parseRuleset(input: unknown): RulesetCheck {
  const missing: string[] = [];
  const root = obj(input);
  // Nothing unfinished anywhere: approval metadata and guideline options included.
  if (JSON.stringify(input ?? null).includes('TODO_CLINICAL')) missing.push('TODO_CLINICAL');
  const num = (
    o: Record<string, unknown>,
    path: string,
    key: string,
    min: number,
    max: number,
    integer = false,
  ) => {
    const v = new Map(Object.entries(o)).get(key);
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isInteger(v))
    ) {
      missing.push(`${path}.${key}`);
      return 0;
    }
    return v;
  };
  const pick = <T extends string>(
    o: Record<string, unknown>,
    path: string,
    key: string,
    options: readonly T[],
  ): T => {
    const v = new Map(Object.entries(o)).get(key);
    if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) {
      missing.push(`${path}.${key}`);
      return options[0] as T;
    }
    return v as T;
  };
  const version = root['version'];
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    missing.push('version');
  const approvedBy = root['approved_by'];
  const approvedOn = root['approved_on'];
  if (typeof approvedBy !== 'string' || approvedBy.trim().length < 3) missing.push('approved_by');
  if (typeof approvedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(approvedOn))
    missing.push('approved_on');
  const d = obj(root['definitions']);
  const t = obj(root['thresholds']);
  const mi = obj(t['meaningful_improvement']);
  const b = obj(root['benefit']);
  const g = obj(root['goal']);
  const a = obj(root['adherence']);
  const m = obj(root['modifiers']);
  const excludeDna = g['exclude_did_not_apply'];
  if (typeof excludeDna !== 'boolean') missing.push('goal.exclude_did_not_apply');
  const ruleset: Ruleset = {
    version: typeof version === 'string' ? version : '0.0.0',
    approvedBy: typeof approvedBy === 'string' ? approvedBy : '',
    approvedOn: typeof approvedOn === 'string' ? approvedOn : '',
    definitions: {
      validity: pick(d, 'definitions', 'validity', ['any_submitted'] as const),
      adherence_daily: pick(d, 'definitions', 'adherence_daily', ['answered_weeks'] as const),
      intolerance: pick(d, 'definitions', 'intolerance', ['unbearable_weeks'] as const),
      benefit: pick(d, 'definitions', 'benefit', ['q1_first_last_windows'] as const),
      modifiers: pick(d, 'definitions', 'modifiers', ['v1'] as const),
      empty_goal: pick(d, 'definitions', 'empty_goal', ['not_met'] as const),
    },
    min_values_per_window: num(root, 'root', 'min_values_per_window', 1, 13, true),
    thresholds: {
      min_checkins: num(t, 'thresholds', 'min_checkins', 1, 26, true),
      adherence_threshold: num(t, 'thresholds', 'adherence_threshold', 0, 1),
      intolerance_weeks: num(t, 'thresholds', 'intolerance_weeks', 1, 26, true),
      baseline_window_weeks: num(t, 'thresholds', 'baseline_window_weeks', 1, 13, true),
      recent_window_weeks: num(t, 'thresholds', 'recent_window_weeks', 1, 13, true),
      meaningful_improvement: {
        absolute_points: num(mi, 'thresholds.meaningful_improvement', 'absolute_points', 0, 10),
        relative: num(mi, 'thresholds.meaningful_improvement', 'relative', 0, 1),
        combine: pick(mi, 'thresholds.meaningful_improvement', 'combine', [
          'either',
          'both',
        ] as const),
      },
      minimal_change: num(t, 'thresholds', 'minimal_change', 0, 10),
      goal_met_threshold: num(t, 'thresholds', 'goal_met_threshold', 0, 1),
    },
    benefit: { aggregate: pick(b, 'benefit', 'aggregate', ['mean', 'median', 'max'] as const) },
    goal: {
      partly_counts_as: num(g, 'goal', 'partly_counts_as', 0, 1),
      exclude_did_not_apply: excludeDna === true,
    },
    adherence: {
      device_or_injection: pick(a, 'adherence', 'device_or_injection', ['share_of_yes'] as const),
    },
    modifiers: {
      side_effects_limiting_weeks: num(m, 'modifiers', 'side_effects_limiting_weeks', 1, 26, true),
      barrier_share: num(m, 'modifiers', 'barrier_share', 0, 1),
      data_gaps_missing_weeks: num(m, 'modifiers', 'data_gaps_missing_weeks', 1, 26, true),
    },
  };
  if (
    missing.length === 0 &&
    ruleset.thresholds.meaningful_improvement.absolute_points < ruleset.thresholds.minimal_change
  )
    missing.push(
      'thresholds.minimal_change (must not exceed meaningful_improvement.absolute_points)',
    );
  return missing.length === 0 ? { ok: true, ruleset } : { ok: false, missing };
}
