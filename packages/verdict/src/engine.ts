import { createHash } from 'node:crypto';
import type { Ruleset } from './ruleset.ts';

/**
 * The verdict engine (spec 7): pure and deterministic. No I/O, no clock, no randomness. Same
 * snapshot and same rule set always give the same verdict, trace and input hash (REQ-004).
 *
 * Steps run in the spec's fixed order (7.2); each appends to the trace with the values compared
 * and the threshold used, so the clinician can see why. Red flags always win: a red flag makes
 * the verdict RED_FLAG and the rest is still evaluated and attached as the secondary result.
 */
export type VerdictCode =
  | 'RED_FLAG'
  | 'INSUFFICIENT_DATA'
  | 'NOT_TAKEN_ENOUGH'
  | 'NOT_TOLERATED'
  | 'NOT_WORKING'
  | 'PARTLY_WORKING'
  | 'WORKING';

export type Modifier = 'SIDE_EFFECTS_LIMITING' | 'BARRIER_COST' | 'BARRIER_STOCKOUT' | 'DATA_GAPS';

/** One week's validated answers (spec 6), or null for a missing week: never imputed. */
export interface WeekAnswers {
  readonly Q1?: number;
  readonly Q3?: string;
  readonly Q5?: readonly string[];
  readonly Q6?: string;
  readonly Q7?: number | string;
  readonly Q8?: readonly string[];
}

export interface Snapshot {
  readonly episodeId: string;
  readonly reviewIntervalWeeks: number;
  readonly adherenceMode: 'daily' | 'device_or_injection';
  /** Week 1 to N: her answers, or null when she did not check in that week. */
  readonly weeks: readonly (WeekAnswers | null)[];
  /** Red-flag events recorded during the episode. */
  readonly redFlagEvents: number;
}

export interface TraceStep {
  readonly step: string;
  readonly values: Readonly<Record<string, number | string | boolean | null>>;
  readonly threshold: Readonly<Record<string, number | string | boolean>> | null;
  readonly outcome: string;
}

export interface Verdict {
  readonly code: VerdictCode;
  /** With RED_FLAG: what the rest of the evaluation found. */
  readonly secondary: Exclude<VerdictCode, 'RED_FLAG'> | null;
  readonly modifiers: readonly Modifier[];
  readonly trace: readonly TraceStep[];
  readonly rulesetVersion: string;
  /** SHA-256 of the canonical snapshot: what exactly was judged. */
  readonly inputHash: string;
}

export class SnapshotError extends Error {
  constructor(what: string) {
    super(`Invalid snapshot: ${what}`);
    this.name = 'SnapshotError';
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function aggregate(values: readonly number[], how: Ruleset['benefit']['aggregate']): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (how === 'max') return sorted.at(-1) ?? 0;
  if (how === 'median') {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted.at(mid) ?? 0)
      : ((sorted.at(mid - 1) ?? 0) + (sorted.at(mid) ?? 0)) / 2;
  }
  return sorted.reduce((s, v) => s + v, 0) / sorted.length;
}

/** Canonical JSON (sorted keys) for the input hash. Refuses values JSON cannot represent. */
export function canonical(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint')
    throw new TypeError('not a JSON value');
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError('non-finite number');
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function inputHash(snapshot: Snapshot): string {
  return createHash('sha256')
    .update(`endo-verdict-input-v1\n${canonical(snapshot)}`)
    .digest('hex');
}

const Q6 = ['not_at_all', 'a_little', 'a_lot', 'unbearable'];
const Q3 = ['yes', 'partly', 'no', 'did_not_apply'];
const isInt = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Every answer the engine reads is checked: finite, in range, from its list (spec 6). */
function checkWeek(w: WeekAnswers, mode: Snapshot['adherenceMode']): void {
  if (w.Q1 !== undefined && !isInt(w.Q1, 0, 10)) throw new SnapshotError('Q1');
  if (w.Q3 !== undefined && !Q3.includes(w.Q3)) throw new SnapshotError('Q3');
  if (w.Q6 !== undefined && !Q6.includes(w.Q6)) throw new SnapshotError('Q6');
  if (w.Q7 !== undefined) {
    const ok = mode === 'daily' ? isInt(w.Q7, 0, 7) : w.Q7 === 'yes' || w.Q7 === 'no';
    if (!ok) throw new SnapshotError('Q7');
  }
  for (const list of [w.Q5, w.Q8])
    if (list !== undefined && (!Array.isArray(list) || !list.every((x) => typeof x === 'string')))
      throw new SnapshotError('Q5/Q8');
}

function check(snapshot: Snapshot, r: Ruleset): void {
  if (snapshot.weeks.length !== snapshot.reviewIntervalWeeks)
    throw new SnapshotError('one entry per week of the episode');
  for (const w of snapshot.weeks) if (w !== null) checkWeek(w, snapshot.adherenceMode);
  const t = r.thresholds;
  if (t.baseline_window_weeks + t.recent_window_weeks > snapshot.reviewIntervalWeeks)
    throw new SnapshotError('baseline and recent windows overlap for this review interval');
}

/** Everything after the red-flag step (spec 7.2 lines 2 onwards). */
function judge(s: Snapshot, r: Ruleset, trace: TraceStep[]): Exclude<VerdictCode, 'RED_FLAG'> {
  const t = r.thresholds;
  const submitted = s.weeks.filter((w): w is WeekAnswers => w !== null);
  trace.push({
    step: 'min_checkins',
    // Section 24 item 25: "valid" is any submitted check-in until defined otherwise.
    values: { submitted: submitted.length, missing: s.weeks.length - submitted.length },
    threshold: { min_checkins: t.min_checkins },
    outcome: submitted.length < t.min_checkins ? 'INSUFFICIENT_DATA' : 'pass',
  });
  if (submitted.length < t.min_checkins) return 'INSUFFICIENT_DATA';

  let ratio: number;
  if (s.adherenceMode === 'daily') {
    const days = submitted
      .map((w) => (typeof w.Q7 === 'number' ? w.Q7 : null))
      .filter((d) => d !== null);
    ratio = days.length === 0 ? 0 : days.reduce((a, d) => a + d, 0) / (7 * days.length);
  } else {
    const answers = submitted.map((w) => w.Q7).filter((a) => a === 'yes' || a === 'no');
    ratio = answers.length === 0 ? 0 : answers.filter((a) => a === 'yes').length / answers.length;
  }
  const barriers = new Map<string, number>();
  for (const w of submitted)
    for (const b of w.Q8 ?? []) barriers.set(b, (barriers.get(b) ?? 0) + 1);
  trace.push({
    step: 'adherence',
    values: {
      mode: s.adherenceMode,
      ratio: round(ratio),
      ...Object.fromEntries(
        [...barriers].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [`barrier_${k}`, v]),
      ),
    },
    threshold: { adherence_threshold: t.adherence_threshold },
    outcome: ratio < t.adherence_threshold ? 'NOT_TAKEN_ENOUGH' : 'pass',
  });
  if (ratio < t.adherence_threshold) return 'NOT_TAKEN_ENOUGH';

  const unbearable = submitted.filter((w) => w.Q6 === 'unbearable').length;
  trace.push({
    step: 'tolerability',
    // Spec 7.2 "patient-reported stop due to side effects" has no question yet (item 27).
    values: { unbearable_weeks: unbearable, reported_stop: null },
    threshold: { intolerance_weeks: t.intolerance_weeks },
    outcome: unbearable >= t.intolerance_weeks ? 'NOT_TOLERATED' : 'pass',
  });
  if (unbearable >= t.intolerance_weeks) return 'NOT_TOLERATED';

  const q1 = (from: number, to: number) =>
    s.weeks
      .slice(from, to)
      .map((w) => (w && typeof w.Q1 === 'number' ? w.Q1 : null))
      .filter((v) => v !== null);
  const baseline = q1(0, t.baseline_window_weeks);
  const recent = q1(s.weeks.length - t.recent_window_weeks, s.weeks.length);
  if (baseline.length < r.min_values_per_window || recent.length < r.min_values_per_window) {
    trace.push({
      step: 'benefit',
      values: { baseline_weeks: baseline.length, recent_weeks: recent.length },
      threshold: { min_values_per_window: r.min_values_per_window },
      outcome: 'INSUFFICIENT_DATA',
    });
    return 'INSUFFICIENT_DATA';
  }
  // Compared unrounded; rounded only for the trace (review 2026-11-15).
  const before = aggregate(baseline, r.benefit.aggregate);
  const after = aggregate(recent, r.benefit.aggregate);
  const absolute = before - after;
  const relative = before > 0 ? absolute / before : null;
  const mi = t.meaningful_improvement;
  const byAbsolute = absolute >= mi.absolute_points;
  const byRelative = relative !== null && relative >= mi.relative;
  const meaningful = mi.combine === 'both' ? byAbsolute && byRelative : byAbsolute || byRelative;

  const goalWeeks = submitted
    .map((w) => w.Q3)
    .filter((g): g is string => typeof g === 'string')
    .filter((g) => !(r.goal.exclude_did_not_apply && g === 'did_not_apply'));
  const met = goalWeeks.reduce(
    (sum, g) => sum + (g === 'yes' ? 1 : g === 'partly' ? r.goal.partly_counts_as : 0),
    0,
  );
  // definitions.empty_goal = 'not_met': no eligible goal weeks counts as not met.
  const goalRatio = goalWeeks.length === 0 ? 0 : met / goalWeeks.length;
  const outcome =
    meaningful && goalRatio >= t.goal_met_threshold
      ? 'WORKING'
      : absolute > t.minimal_change
        ? 'PARTLY_WORKING'
        : 'NOT_WORKING';
  trace.push({
    step: 'benefit',
    values: {
      aggregate: r.benefit.aggregate,
      baseline_q1: round(before),
      recent_q1: round(after),
      absolute_reduction: round(absolute),
      relative_reduction: relative === null ? null : round(relative),
      goal_met_ratio: round(goalRatio),
      goal_weeks: goalWeeks.length,
    },
    threshold: {
      meaningful_absolute: mi.absolute_points,
      meaningful_relative: mi.relative,
      combine: mi.combine,
      minimal_change: t.minimal_change,
      goal_met_threshold: t.goal_met_threshold,
    },
    outcome,
  });
  return outcome;
}

function modifiers(s: Snapshot, r: Ruleset, trace: TraceStep[]): Modifier[] {
  const m = r.modifiers;
  const submitted = s.weeks.filter((w): w is WeekAnswers => w !== null);
  const limiting = submitted.filter((w) => w.Q6 === 'a_lot' || w.Q6 === 'unbearable').length;
  const share = (b: string) =>
    submitted.length === 0
      ? 0
      : submitted.filter((w) => (w.Q8 ?? []).includes(b)).length / submitted.length;
  const missing = s.weeks.length - submitted.length;
  const out: Modifier[] = [];
  if (limiting >= m.side_effects_limiting_weeks) out.push('SIDE_EFFECTS_LIMITING');
  if (share('cost') >= m.barrier_share && share('cost') > 0) out.push('BARRIER_COST');
  if (share('ran_out') >= m.barrier_share && share('ran_out') > 0) out.push('BARRIER_STOCKOUT');
  if (missing >= m.data_gaps_missing_weeks) out.push('DATA_GAPS');
  trace.push({
    step: 'modifiers',
    values: {
      limiting_weeks: limiting,
      cost_share: round(share('cost')),
      ran_out_share: round(share('ran_out')),
      missing_weeks: missing,
    },
    threshold: {
      side_effects_limiting_weeks: m.side_effects_limiting_weeks,
      barrier_share: m.barrier_share,
      data_gaps_missing_weeks: m.data_gaps_missing_weeks,
    },
    outcome: out.join(',') || 'none',
  });
  return out;
}

/**
 * Evaluates one episode (spec 7.2). Red flags come first and always win, even when the rest of
 * the snapshot cannot be judged: then the verdict is RED_FLAG with no secondary result. Without a
 * red flag, a malformed snapshot throws SnapshotError (never a guess). Modifiers are added after
 * the result ("add modifiers", 7.2), whichever step decided it.
 */
export function evaluate(snapshot: Snapshot, ruleset: Ruleset): Verdict {
  if (!Number.isInteger(snapshot.redFlagEvents) || snapshot.redFlagEvents < 0)
    throw new SnapshotError('red-flag count');
  const trace: TraceStep[] = [];
  const redFlag = snapshot.redFlagEvents > 0;
  trace.push({
    step: 'red_flags',
    values: { events: snapshot.redFlagEvents },
    threshold: null,
    outcome: redFlag ? 'RED_FLAG' : 'pass',
  });
  try {
    check(snapshot, ruleset);
  } catch (error) {
    if (!redFlag || !(error instanceof SnapshotError)) throw error;
    trace.push({
      step: 'snapshot',
      values: { error: error.message },
      threshold: null,
      outcome: 'not_judged',
    });
    return {
      code: 'RED_FLAG',
      secondary: null,
      modifiers: [],
      trace,
      rulesetVersion: ruleset.version,
      inputHash: inputHash(snapshot),
    };
  }
  const result = judge(snapshot, ruleset, trace);
  const mods = modifiers(snapshot, ruleset, trace);
  return {
    code: redFlag ? 'RED_FLAG' : result,
    secondary: redFlag ? result : null,
    modifiers: mods,
    trace,
    rulesetVersion: ruleset.version,
    inputHash: inputHash(snapshot),
  };
}
