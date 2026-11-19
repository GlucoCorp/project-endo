import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSync } from 'node:crypto';
import {
  SnapshotError,
  evaluate,
  inputHash,
  parseRuleset,
  runGoldenCases,
  signRuleset,
  verifyRuleset,
  type GoldenCase,
  type Ruleset,
  type Snapshot,
  type WeekAnswers,
} from './index.ts';

/**
 * TEST-ONLY rule set. These numbers exercise the engine's branches and have no clinical standing;
 * the real values come only from the clinical lead (clinical/rulesets, spec 7.3).
 */
const TEST_RULESET_INPUT = {
  version: '0.0.1',
  approved_by: 'TEST-ONLY, no clinical standing',
  approved_on: '2026-11-15',
  definitions: {
    validity: 'any_submitted',
    adherence_daily: 'answered_weeks',
    intolerance: 'unbearable_weeks',
    benefit: 'q1_first_last_windows',
    modifiers: 'v1',
    empty_goal: 'not_met',
  },
  min_values_per_window: 1,
  thresholds: {
    min_checkins: 8,
    adherence_threshold: 0.8,
    intolerance_weeks: 2,
    baseline_window_weeks: 2,
    recent_window_weeks: 4,
    meaningful_improvement: { absolute_points: 2, relative: 0.3, combine: 'either' },
    minimal_change: 1,
    goal_met_threshold: 0.5,
  },
  benefit: { aggregate: 'mean' },
  goal: { partly_counts_as: 0.5, exclude_did_not_apply: true },
  adherence: { device_or_injection: 'share_of_yes' },
  modifiers: { side_effects_limiting_weeks: 3, barrier_share: 0.25, data_gaps_missing_weeks: 3 },
};
const parsed = parseRuleset(TEST_RULESET_INPUT);
if (!parsed.ok) throw new Error('test rule set incomplete');
const R: Ruleset = parsed.ruleset;

const week = (o: Partial<WeekAnswers> = {}): WeekAnswers => ({
  Q1: 6,
  Q3: 'yes',
  Q5: [],
  Q7: 7,
  Q8: ['none'],
  ...o,
});
const snap = (weeks: (WeekAnswers | null)[], o: Partial<Snapshot> = {}): Snapshot => ({
  episodeId: '01900000-0000-7000-8000-0000000000e5',
  reviewIntervalWeeks: weeks.length,
  adherenceMode: 'daily',
  weeks,
  redFlagEvents: 0,
  ...o,
});
const twelve = (f: (i: number) => WeekAnswers | null) => Array.from({ length: 12 }, (_, i) => f(i));
/** Pain from 8 down to 3: a clear improvement. */
const improving = twelve((i) => week({ Q1: Math.max(3, 8 - i) }));

describe('REQ-004 spec 7.3 rule set', () => {
  it('lists every missing or TODO_CLINICAL value; nothing has a default', async () => {
    const real = await import('node:fs').then(
      (fs) =>
        JSON.parse(
          fs.readFileSync(
            new URL('../../../clinical/rulesets/ruleset.1.0.0.json', import.meta.url),
            'utf8',
          ),
        ) as unknown,
    );
    const r = parseRuleset(real);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain('thresholds.min_checkins');
      expect(r.missing).toContain('benefit.aggregate');
      expect(r.missing).toContain('goal.exclude_did_not_apply');
      expect(r.missing).toContain('adherence.device_or_injection');
    }
    expect(parseRuleset(null)).toMatchObject({ ok: false });
    expect(parseRuleset({ ...TEST_RULESET_INPUT, version: '1' })).toEqual({
      ok: false,
      missing: ['version'],
    });
    const crossed = {
      ...TEST_RULESET_INPUT,
      thresholds: { ...TEST_RULESET_INPUT.thresholds, minimal_change: 3 },
    };
    expect(parseRuleset(crossed)).toMatchObject({ ok: false });
  });
});

describe('REQ-004 spec 7.2 algorithm, in its fixed order', () => {
  it('WORKING: meaningful benefit and goal met', () => {
    const v = evaluate(snap(improving), R);
    expect(v.code).toBe('WORKING');
    expect(v.secondary).toBeNull();
    expect(v.trace.map((t) => t.step)).toEqual([
      'red_flags',
      'min_checkins',
      'adherence',
      'tolerability',
      'benefit',
      'modifiers',
    ]);
    const b = v.trace.find((t) => t.step === 'benefit');
    expect(b?.values).toMatchObject({ baseline_q1: 7.5, recent_q1: 3, absolute_reduction: 4.5 });
    expect(b?.threshold).toMatchObject({ meaningful_absolute: 2, minimal_change: 1 });
  });

  it('PARTLY_WORKING: some benefit but the goal not consistently met', () => {
    expect(evaluate(snap(improving.map((w) => ({ ...w, Q3: 'no' }))), R).code).toBe(
      'PARTLY_WORKING',
    );
  });

  it('NOT_WORKING: taken properly, no meaningful change', () => {
    expect(evaluate(snap(twelve(() => week())), R).code).toBe('NOT_WORKING');
  });

  it('INSUFFICIENT_DATA: too few check-ins; missing weeks are never filled in', () => {
    const v = evaluate(snap(twelve((i) => (i < 7 ? week() : null))), R);
    expect(v.code).toBe('INSUFFICIENT_DATA');
    expect(v.trace[1]?.values).toEqual({ submitted: 7, missing: 5 });
    // Data, but none in the baseline window: cannot compare.
    const noBaseline = twelve((i) => (i < 2 ? null : week()));
    expect(evaluate(snap(noBaseline), R).code).toBe('INSUFFICIENT_DATA');
  });

  it('NOT_TAKEN_ENOUGH: low adherence, with the barriers listed', () => {
    const v = evaluate(snap(improving.map((w) => ({ ...w, Q7: 3, Q8: ['cost'] }))), R);
    expect(v.code).toBe('NOT_TAKEN_ENOUGH');
    expect(v.trace.find((t) => t.step === 'adherence')?.values).toMatchObject({ barrier_cost: 12 });
    expect(v.modifiers).toContain('BARRIER_COST');
  });

  it('devices and injections: adherence is the share of weeks answered "yes"', () => {
    const device = improving.map((w, i) => ({ ...w, Q7: i < 10 ? 'yes' : 'no' }));
    expect(evaluate(snap(device, { adherenceMode: 'device_or_injection' }), R).code).toBe(
      'WORKING',
    );
    const mostlyNo = improving.map((w, i) => ({ ...w, Q7: i < 6 ? 'yes' : 'no' }));
    expect(evaluate(snap(mostlyNo, { adherenceMode: 'device_or_injection' }), R).code).toBe(
      'NOT_TAKEN_ENOUGH',
    );
  });

  it('NOT_TOLERATED: enough weeks rated unbearable', () => {
    const v = evaluate(
      snap(improving.map((w, i) => ({ ...w, Q5: ['x'], Q6: i < 2 ? 'unbearable' : 'a_little' }))),
      R,
    );
    expect(v.code).toBe('NOT_TOLERATED');
  });

  it('red flags always win, and the rest is still evaluated as the secondary result', () => {
    const v = evaluate(snap(improving, { redFlagEvents: 1 }), R);
    expect(v.code).toBe('RED_FLAG');
    expect(v.secondary).toBe('WORKING');
  });

  it('adds modifiers: side effects limiting, stock-outs and data gaps', () => {
    const weeks = improving.map((w, i) =>
      i >= 9
        ? null
        : { ...w, Q5: ['x'], Q6: i < 3 ? 'a_lot' : 'a_little', Q8: i < 4 ? ['ran_out'] : ['none'] },
    );
    const v = evaluate(snap(weeks), {
      ...R,
      thresholds: { ...R.thresholds, recent_window_weeks: 2, min_checkins: 6 },
    });
    expect(v.modifiers).toEqual(['SIDE_EFFECTS_LIMITING', 'BARRIER_STOCKOUT', 'DATA_GAPS']);
  });

  it('applies the rule set’s choices: aggregate, combine, partly and did-not-apply', () => {
    const median = { ...R, benefit: { aggregate: 'median' as const } };
    const max = { ...R, benefit: { aggregate: 'max' as const } };
    expect(evaluate(snap(improving), median).code).toBe('WORKING');
    expect(evaluate(snap(improving), max).code).toBe('WORKING');
    // A zero baseline has no relative change; "both" then cannot be met.
    const flat = twelve((i) => week({ Q1: i < 2 ? 0 : 0 }));
    const both = {
      ...R,
      thresholds: {
        ...R.thresholds,
        meaningful_improvement: { absolute_points: 0, relative: 0.3, combine: 'both' as const },
      },
    };
    const b = evaluate(snap(flat), both);
    expect(b.trace.find((t) => t.step === 'benefit')?.values['relative_reduction']).toBeNull();
    expect(b.code).not.toBe('WORKING');
    const partly = improving.map((w) => ({ ...w, Q3: 'partly' }));
    expect(evaluate(snap(partly), R).code).toBe('WORKING'); // 0.5 >= 0.5
    expect(evaluate(snap(partly), { ...R, goal: { ...R.goal, partly_counts_as: 0 } }).code).toBe(
      'PARTLY_WORKING',
    );
    const dna = improving.map((w, i) => ({ ...w, Q3: i % 2 === 0 ? 'did_not_apply' : 'yes' }));
    expect(evaluate(snap(dna), R).code).toBe('WORKING');
    expect(
      evaluate(snap(dna), {
        ...R,
        goal: { ...R.goal, exclude_did_not_apply: false },
        thresholds: { ...R.thresholds, goal_met_threshold: 0.6 },
      }).code,
    ).toBe('PARTLY_WORKING');
  });

  it('refuses a malformed snapshot rather than guessing', () => {
    expect(() => evaluate(snap(improving, { reviewIntervalWeeks: 13 }), R)).toThrow(SnapshotError);
    expect(() => evaluate(snap(improving, { redFlagEvents: -1 }), R)).toThrow(SnapshotError);
    expect(() => evaluate(snap(improving.slice(0, 5)), R)).toThrow(/overlap/);
  });
});

describe('REQ-004 spec 7.4 properties', () => {
  const arbWeek = fc.option(
    fc.record({
      Q1: fc.integer({ min: 0, max: 10 }),
      Q3: fc.constantFrom('yes', 'partly', 'no', 'did_not_apply'),
      Q5: fc.constant([] as string[]),
      Q6: fc.constantFrom('not_at_all', 'a_little', 'a_lot', 'unbearable'),
      Q7: fc.integer({ min: 0, max: 7 }),
      Q8: fc.constantFrom(['none'], ['cost'], ['ran_out'], ['forgot']),
    }),
    { nil: null },
  );
  const arbSnap = fc.record({
    weeks: fc.array(arbWeek, { minLength: 12, maxLength: 12 }),
    redFlagEvents: fc.integer({ min: 0, max: 3 }),
  });

  it('is deterministic: same inputs and rule set, same verdict, trace and hash', () => {
    fc.assert(
      fc.property(arbSnap, (a) => {
        const s = snap(a.weeks, { redFlagEvents: a.redFlagEvents });
        expect(evaluate(s, R)).toEqual(evaluate(structuredClone(s), R));
      }),
    );
  });

  it('red-flag dominance: any red flag makes the verdict RED_FLAG', () => {
    fc.assert(
      fc.property(arbSnap, fc.integer({ min: 1, max: 5 }), (a, n) => {
        const v = evaluate(snap(a.weeks, { redFlagEvents: n }), R);
        expect(v.code).toBe('RED_FLAG');
        expect(v.secondary).not.toBeNull();
      }),
    );
  });

  it('monotonic: more adherence never makes NOT_TAKEN_ENOUGH more likely', () => {
    fc.assert(
      fc.property(arbSnap, fc.integer({ min: 0, max: 11 }), (a, i) => {
        const before = evaluate(snap(a.weeks), R).code;
        const weeks = a.weeks.map((w, j) => (j === i && w ? { ...w, Q7: 7 } : w));
        const after = evaluate(snap(weeks), R).code;
        if (before !== 'NOT_TAKEN_ENOUGH') expect(after).not.toBe('NOT_TAKEN_ENOUGH');
      }),
    );
  });

  it('the input hash changes whenever the snapshot does', () => {
    const a = snap(improving);
    const b = snap(improving.map((w, i) => (i === 3 ? { ...w, Q1: 9 } : w)));
    expect(inputHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(inputHash(a)).not.toBe(inputHash(b));
    expect(evaluate(a, R).inputHash).toBe(inputHash(a));
  });
});

describe('spec 18.5 rule set signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trusted = new Map([['clinical-2026', publicKey.export({ format: 'jwk' })]]);
  const priv = privateKey.export({ format: 'jwk' });

  it('verifies a signed rule set whatever its key order or formatting', () => {
    const sig = signRuleset(TEST_RULESET_INPUT, 'clinical-2026', priv);
    const reordered = JSON.parse(
      JSON.stringify({ ...TEST_RULESET_INPUT, version: TEST_RULESET_INPUT.version }),
    ) as unknown;
    expect(verifyRuleset(reordered, sig, trusted)).toEqual({ ok: true, keyId: 'clinical-2026' });
  });

  it('refuses a changed value, an unknown key, a malformed file and a non-Ed25519 key', () => {
    const sig = signRuleset(TEST_RULESET_INPUT, 'clinical-2026', priv);
    const changed = {
      ...TEST_RULESET_INPUT,
      thresholds: { ...TEST_RULESET_INPUT.thresholds, min_checkins: 2 },
    };
    expect(verifyRuleset(changed, sig, trusted)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRuleset(TEST_RULESET_INPUT, { ...sig, key_id: 'other' }, trusted)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(verifyRuleset(TEST_RULESET_INPUT, { key_id: 'x' }, trusted)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyRuleset(TEST_RULESET_INPUT, null, trusted)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrong = new Map([['clinical-2026', rsa.publicKey.export({ format: 'jwk' })]]);
    expect(verifyRuleset(TEST_RULESET_INPUT, sig, wrong)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(
      verifyRuleset(TEST_RULESET_INPUT, sig, new Map([['clinical-2026', { kty: 'OKP' }]])),
    ).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(() =>
      signRuleset(TEST_RULESET_INPUT, 'k', rsa.privateKey.export({ format: 'jwk' })),
    ).toThrow(TypeError);
  });
});

describe('spec 7.4 golden cases', () => {
  it('passes, fails or stays pending until the clinical lead sets the expected verdict', () => {
    const none = { secondary: null, modifiers: [] };
    const cases: GoldenCase[] = [
      {
        id: 'g1',
        description: 'improving',
        snapshot: snap(improving),
        expected: { code: 'WORKING', ...none },
      },
      {
        id: 'g2',
        description: 'flat',
        snapshot: snap(twelve(() => week())),
        expected: { code: 'WORKING', ...none },
      },
      {
        id: 'g3',
        description: 'red flag',
        snapshot: snap(improving, { redFlagEvents: 1 }),
        expected: { code: 'RED_FLAG', secondary: 'WORKING', modifiers: [] },
      },
      { id: 'g4', description: 'candidate', snapshot: snap(improving), expected: 'TODO_CLINICAL' },
      // An unexpected modifier fails: expectations are never filled in from the result.
      {
        id: 'g5',
        description: 'gaps',
        snapshot: snap(improving.map((w, i) => (i > 2 && i < 7 ? null : w))),
        expected: { code: 'WORKING', ...none },
      },
      // A case that throws fails on its own; the batch goes on.
      {
        id: 'g6',
        description: 'broken',
        snapshot: snap(improving.slice(0, 3)),
        expected: { code: 'WORKING', ...none },
      },
    ];
    expect(runGoldenCases(cases, R)).toEqual([
      { id: 'g1', status: 'pass' },
      { id: 'g2', status: 'fail', expected: 'WORKING', actual: 'NOT_WORKING' },
      { id: 'g3', status: 'pass' },
      { id: 'g4', status: 'pending' },
      { id: 'g5', status: 'fail', expected: 'WORKING', actual: 'WORKING+DATA_GAPS' },
      { id: 'g6', status: 'fail', expected: 'WORKING', actual: 'error: SnapshotError' },
    ]);
  });
});

describe('REQ-004 review fixes (Codex, 2026-11-15)', () => {
  it('a red flag wins even when the rest of the snapshot cannot be judged', () => {
    const v = evaluate(snap(improving.slice(0, 4), { redFlagEvents: 1 }), R);
    expect(v.code).toBe('RED_FLAG');
    expect(v.secondary).toBeNull();
    expect(v.trace.map((t) => t.step)).toEqual(['red_flags', 'snapshot']);
  });

  it('refuses non-finite or out-of-list answers instead of classifying them', () => {
    for (const bad of [
      { Q7: Number.NaN },
      { Q1: Number.NaN },
      { Q1: 11 },
      { Q3: 'maybe' },
      { Q6: 'x' },
      { Q7: 'yes' },
    ])
      expect(() =>
        evaluate(snap(improving.map((w, i) => (i === 0 ? { ...w, ...bad } : w))), R),
      ).toThrow(SnapshotError);
    expect(() =>
      evaluate(
        snap(
          improving.map((w) => ({ ...w, Q7: 3 })),
          { adherenceMode: 'device_or_injection' },
        ),
        R,
      ),
    ).toThrow(SnapshotError);
    expect(() =>
      evaluate(
        snap(improving.map((w, i) => (i === 0 ? { ...w, Q8: 'cost' as unknown as string[] } : w))),
        R,
      ),
    ).toThrow(SnapshotError);
  });

  it('compares unrounded values: just below a threshold never rounds up to pass', () => {
    // 83/84 = 0.98809523... against 0.988096: rounding to 6 places would pass it; it must not.
    const close = { ...R, thresholds: { ...R.thresholds, adherence_threshold: 0.988096 } };
    const nearly = improving.map((w, i) => ({ ...w, Q7: i === 0 ? 6 : 7 }));
    expect(evaluate(snap(nearly), close).code).toBe('NOT_TAKEN_ENOUGH');
    const exact = { ...R, thresholds: { ...R.thresholds, adherence_threshold: 1 } };
    const almost = improving.map((w, i) => ({ ...w, Q7: i === 0 ? 6 : 7 }));
    expect(evaluate(snap(almost), exact).code).toBe('NOT_TAKEN_ENOUGH');
  });

  it('needs every window to hold enough values', () => {
    const r = { ...R, min_values_per_window: 2 };
    const oneBaseline = improving.map((w, i) => (i === 1 ? null : w));
    expect(evaluate(snap(oneBaseline), r).code).toBe('INSUFFICIENT_DATA');
  });

  it('refuses a rule set with approval missing, a fraction where a count is needed, or any TODO', () => {
    const bad = (patch: object) => parseRuleset({ ...TEST_RULESET_INPUT, ...patch });
    expect(bad({ approved_by: 'TODO_CLINICAL' })).toMatchObject({ ok: false });
    expect(bad({ approved_on: 'soon' })).toMatchObject({ ok: false, missing: ['approved_on'] });
    expect(
      bad({ thresholds: { ...TEST_RULESET_INPUT.thresholds, min_checkins: 7.5 } }),
    ).toMatchObject({
      ok: false,
      missing: ['thresholds.min_checkins'],
    });
    expect(
      bad({ definitions: { ...TEST_RULESET_INPUT.definitions, benefit: 'q2' } }),
    ).toMatchObject({
      ok: false,
      missing: ['definitions.benefit'],
    });
    expect(bad({ guideline_options: 'TODO_CLINICAL' })).toMatchObject({
      ok: false,
      missing: ['TODO_CLINICAL'],
    });
  });

  it('signatures must be exactly 64 bytes in canonical base64url; canonical form refuses non-JSON', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trusted = new Map([['k', publicKey.export({ format: 'jwk' })]]);
    const sig = signRuleset(TEST_RULESET_INPUT, 'k', privateKey.export({ format: 'jwk' }));
    const last = sig.signature.slice(-1);
    const twisted = sig.signature.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(verifyRuleset(TEST_RULESET_INPUT, { ...sig, signature: twisted }, trusted).ok).toBe(
      false,
    );
    expect(verifyRuleset({ a: Number.NaN }, sig, trusted)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(() => inputHash({ ...snap(improving), weeks: [undefined as unknown as null] })).toThrow(
      TypeError,
    );
  });
});
