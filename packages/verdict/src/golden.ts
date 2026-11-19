import { evaluate, type Modifier, type Snapshot, type VerdictCode } from './engine.ts';
import type { Ruleset } from './ruleset.ts';

/**
 * Golden cases (spec 7.4): synthetic patients with the verdict the clinical lead expects. An
 * engineer may write the snapshot; only the clinical lead writes `expected`. Until then it is
 * `TODO_CLINICAL` and the case is reported as pending, never as passing.
 */
export interface GoldenCase {
  readonly id: string;
  readonly description: string;
  readonly snapshot: Snapshot;
  readonly expected:
    | 'TODO_CLINICAL'
    | {
        readonly code: VerdictCode;
        /** Required: what the clinical lead expects, nothing inferred from the result. */
        readonly secondary: Exclude<VerdictCode, 'RED_FLAG'> | null;
        readonly modifiers: readonly Modifier[];
      };
}

export type GoldenResult =
  | { readonly id: string; readonly status: 'pass' }
  | { readonly id: string; readonly status: 'pending' }
  | {
      readonly id: string;
      readonly status: 'fail';
      readonly expected: string;
      readonly actual: string;
    };

const describeVerdict = (code: string, secondary: string | null, modifiers: readonly string[]) =>
  [
    code,
    secondary ? `(${secondary})` : '',
    modifiers.length ? `+${[...modifiers].sort().join('+')}` : '',
  ]
    .join('')
    .trim();

/**
 * Runs every case; a case whose expected verdict is not yet signed off is `pending`. Expected
 * secondary and modifiers must be stated; a case that throws fails on its own.
 */
export function runGoldenCases(cases: readonly GoldenCase[], ruleset: Ruleset): GoldenResult[] {
  return cases.map((c) => {
    if (c.expected === 'TODO_CLINICAL') return { id: c.id, status: 'pending' };
    const e = c.expected;
    const expected = describeVerdict(e.code, e.secondary, e.modifiers);
    let actual: string;
    try {
      const v = evaluate(c.snapshot, ruleset);
      actual = describeVerdict(v.code, v.secondary, v.modifiers);
    } catch (error) {
      actual = `error: ${error instanceof Error ? error.name : 'unknown'}`;
    }
    return expected === actual
      ? { id: c.id, status: 'pass' }
      : { id: c.id, status: 'fail', expected, actual };
  });
}
