import type { CheckInContent } from './api.ts';

/**
 * The weekly check-in as a sequence of single-question screens (spec 6, 21.7 screen 5). Red flags
 * come first and cannot be skipped (6.3): if she reports any, the urgent screen shows at once,
 * before anything else, and the flags are sent on their own before the rest.
 */
export type Step = 'red_flags' | 'Q1' | 'Q2' | 'Q3' | 'Q5' | 'Q6' | 'Q7' | 'Q8' | 'GIC' | 'review';

export type AnswerKey = Exclude<Step, 'review'>;
export type AnswerValue = number | string | readonly string[];
export type Answers = ReadonlyMap<AnswerKey, AnswerValue>;

/** The screens for this week, in order, given the answers so far (Q6 only after a side effect). */
export function stepsFor(content: CheckInContent, weekIndex: number, answers: Answers): Step[] {
  const steps: Step[] = ['red_flags', 'Q1', 'Q2', 'Q3', 'Q5'];
  const effects = answers.get('Q5');
  if (Array.isArray(effects) && effects.length > 0) steps.push('Q6');
  steps.push('Q7', 'Q8');
  if (content.review_weeks.includes(weekIndex)) steps.push('GIC');
  steps.push('review');
  return steps;
}

/** The next screen after `current`, or `review` at the end. */
export function nextStep(
  content: CheckInContent,
  weekIndex: number,
  answers: Answers,
  current: Step,
): Step {
  const steps = stepsFor(content, weekIndex, answers);
  const i = steps.indexOf(current);
  return steps[Math.min(i + 1, steps.length - 1)] ?? 'review';
}

export function previousStep(
  content: CheckInContent,
  weekIndex: number,
  answers: Answers,
  current: Step,
): Step | null {
  const steps = stepsFor(content, weekIndex, answers);
  const i = steps.indexOf(current);
  return i > 0 ? (steps[i - 1] ?? null) : null;
}

/** "3 of 8": progress as words, not a bar (21.7). Review is not counted. */
export function progress(
  content: CheckInContent,
  weekIndex: number,
  answers: Answers,
  current: Step,
) {
  const steps: Step[] = stepsFor(content, weekIndex, answers).filter((s) => s !== 'review');
  return { index: Math.max(steps.indexOf(current), 0) + 1, total: steps.length };
}

/** Whether the screen has an answer she can move on with. */
export function answered(step: Step, answers: Answers): boolean {
  if (step === 'review') return true;
  const v = answers.get(step);
  if (step === 'red_flags' || step === 'Q5') return Array.isArray(v);
  if (step === 'Q8') return Array.isArray(v) && v.length > 0;
  return v !== undefined;
}

/** The body the API validates: only the answers her screens asked for. */
export function toSubmission(content: CheckInContent, weekIndex: number, answers: Answers) {
  const out = new Map<string, AnswerValue>();
  for (const step of stepsFor(content, weekIndex, answers)) {
    if (step === 'review') continue;
    const v = answers.get(step);
    if (v !== undefined) out.set(step, v);
  }
  return Object.fromEntries(out);
}

/** Toggles an option in a multi-select; "none" clears the others and is cleared by them. */
export function toggle(list: readonly string[] | undefined, option: string, none: string | null) {
  const current = list ?? [];
  if (current.includes(option)) return current.filter((x) => x !== option);
  if (none && option === none) return [none];
  return [...current.filter((x) => x !== none), option];
}

/** Days from `today` to `date` (both YYYY-MM-DD), never negative. */
export function daysUntil(today: string, date: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
  );
}

/** Weeks since the start (1-based), capped at the review interval. */
export function weekOf(today: string, start: string, interval: number): number {
  const days = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
  return Math.min(Math.max(Math.floor(days / 7) + 1, 1), interval);
}

/** Her local date, YYYY-MM-DD. */
export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${d}`;
}
