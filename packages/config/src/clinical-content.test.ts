import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ClinicalContentError,
  ClinicalNotReadyError,
  SYNTHETIC_TREATMENT_SYSTEM,
  canonicalJson,
  loadClinicalContent,
  validateAnswers,
} from './index.ts';

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../clinical/${p}`, import.meta.url)), 'utf8');
const files = {
  instrument: read('instrument/checkin.v1.json'),
  treatments: read('treatments/catalogue.v1.json'),
  goals: read('goals/templates.v1.json'),
};

describe('REQ-002, REQ-003, RISK-C01 clinical content', () => {
  it('refuses to start in staging or production while anything is TODO_CLINICAL', () => {
    expect(() => loadClinicalContent('staging', files)).toThrow(ClinicalNotReadyError);
    expect(() => loadClinicalContent('production', files)).toThrow(ClinicalNotReadyError);
  });

  it('uses obviously synthetic placeholders in development, and marks the content draft', () => {
    const c = loadClinicalContent('dev', files);
    expect(c.draft).toBe(true);
    expect(c.instrument.draft).toBe(true);
    expect(c.treatments.every((t) => t.system === SYNTHETIC_TREATMENT_SYSTEM)).toBe(true);
    expect(c.treatments.every((t) => t.display.includes('placeholder'))).toBe(true);
    expect(c.goals.every((g) => g.text.includes('placeholder'))).toBe(true);
    expect(c.instrument.redFlags.map((f) => f.id)).toEqual([
      'RF1',
      'RF2',
      'RF3',
      'RF4',
      'RF5',
      'RF6',
    ]);
    expect(c.instrument.redFlags.find((f) => f.id === 'RF6')?.routesTo).toBe(
      'local_crisis_support',
    );
    expect(c.instrument.bleedingScaleApproved).toBe(false);
    expect(c.instrument.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(c.instrument.text['Q1']).toContain('worst day');
  });

  it('uses approved content as written, and refuses malformed content', () => {
    const treatments = JSON.stringify({
      approved_by: 'Dr Synthetic',
      entries: [
        { system: 'http://www.whocc.no/atc', code: 'X01', display: 'X', adherence_mode: 'daily' },
      ],
    });
    const goals = JSON.stringify({
      approved_by: 'Dr Synthetic',
      templates: [{ code: 'g', text: 'G' }],
    });
    const c = loadClinicalContent('test', { ...files, treatments, goals });
    expect(c.treatments).toEqual([
      { system: 'http://www.whocc.no/atc', code: 'X01', display: 'X', adherenceMode: 'daily' },
    ]);
    expect(c.goals).toEqual([{ code: 'g', text: 'G' }]);
    const bad = (patch: Partial<typeof files>) => () =>
      loadClinicalContent('test', { ...files, ...patch });
    expect(bad({ treatments: '{' })).toThrow(ClinicalContentError);
    expect(bad({ treatments: JSON.stringify({ entries: [{ code: 'x' }] }) })).toThrow(
      ClinicalContentError,
    );
    expect(
      bad({ goals: JSON.stringify({ templates: [{ code: 'g', text: 'x'.repeat(141) }] }) }),
    ).toThrow(ClinicalContentError);
    const ins = JSON.parse(files.instrument) as {
      red_flags: { drafts: unknown[] };
      weekly_questions: unknown[];
    };
    expect(bad({ instrument: JSON.stringify({ ...ins, red_flags: { drafts: [] } }) })).toThrow(
      /no red flags/,
    );
    expect(
      bad({
        instrument: JSON.stringify({ ...ins, weekly_questions: ins.weekly_questions.slice(1) }),
      }),
    ).toThrow(/Q1-Q8/);
    expect(bad({ instrument: JSON.stringify({ ...ins, instrument_version: 'one' }) })).toThrow(
      /version/,
    );
  });
});

describe('REQ-003 spec 6 answer validation', () => {
  const { instrument } = loadClinicalContent('dev', files);
  const good = {
    Q1: 6,
    Q2: 'some_days',
    Q3: 'partly',
    Q5: ['synthetic_effect_b', 'synthetic_effect_a'],
    Q6: 'a_little',
    Q7: 5,
    Q8: ['forgot', 'cost'],
    red_flags: [],
  };
  const check = (a: unknown, mode: 'daily' | 'device_or_injection' = 'daily', week = 1) =>
    validateAnswers(instrument, mode, week, a);

  it('accepts a complete week and normalises it', () => {
    expect(check(good)).toEqual({
      ok: true,
      redFlags: [],
      answers: {
        ...good,
        Q5: ['synthetic_effect_a', 'synthetic_effect_b'],
        Q8: ['cost', 'forgot'],
      },
    });
  });

  it('always needs the red-flag screen answered, with known codes only (spec 6.3)', () => {
    const without: Record<string, unknown> = { ...good };
    delete without['red_flags'];
    expect(check(without)).toEqual({ ok: false, reason: 'red_flags' });
    expect(check({ ...good, red_flags: ['RF99'] })).toEqual({ ok: false, reason: 'red_flags' });
    expect(check({ ...good, red_flags: ['RF3', 'RF1', 'RF3'] })).toMatchObject({
      ok: true,
      redFlags: ['RF1', 'RF3'],
    });
  });

  it('asks Q6 only when a side effect was reported', () => {
    expect(check({ ...good, Q5: [], Q6: undefined })).toMatchObject({ ok: true });
    expect(check({ ...good, Q5: [] })).toEqual({ ok: false, reason: 'Q6' });
    expect(check({ ...good, Q6: undefined })).toEqual({ ok: false, reason: 'Q6' });
  });

  it('follows the episode’s adherence question (spec 6.1 Q7)', () => {
    expect(check({ ...good, Q7: 8 })).toEqual({ ok: false, reason: 'Q7' });
    expect(check({ ...good, Q7: 'yes' })).toEqual({ ok: false, reason: 'Q7' });
    expect(check({ ...good, Q7: 'yes' }, 'device_or_injection')).toMatchObject({ ok: true });
    expect(check(good, 'device_or_injection')).toEqual({ ok: false, reason: 'Q7' });
  });

  it('refuses unknown keys, out-of-range values, a mixed "none", and Q4 until its scale is approved', () => {
    expect(check({ ...good, Q1: 11 })).toEqual({ ok: false, reason: 'Q1' });
    expect(check({ ...good, Q1: 2.5 })).toEqual({ ok: false, reason: 'Q1' });
    expect(check({ ...good, Q2: 'often' })).toEqual({ ok: false, reason: 'Q2' });
    expect(check({ ...good, Q3: 'maybe' })).toEqual({ ok: false, reason: 'Q3' });
    expect(check({ ...good, Q8: ['none', 'cost'] })).toEqual({ ok: false, reason: 'Q8' });
    expect(check({ ...good, Q8: [] })).toEqual({ ok: false, reason: 'Q8' });
    expect(check({ ...good, Q5: ['headache'] })).toEqual({ ok: false, reason: 'Q5' });
    expect(check({ ...good, Q4: 2 })).toEqual({ ok: false, reason: 'unexpected Q4' });
    expect(check({ ...good, note: 'free text' })).toEqual({ ok: false, reason: 'unexpected note' });
    expect(check(null)).toEqual({ ok: false, reason: 'red_flags' });
  });

  it('adds the global impression of change on review weeks only (spec 6.2)', () => {
    expect(check(good, 'daily', 4)).toEqual({ ok: false, reason: 'GIC' });
    expect(check({ ...good, GIC: 3 }, 'daily', 4)).toMatchObject({ ok: true });
    expect(check({ ...good, GIC: 3 }, 'daily', 5)).toEqual({ ok: false, reason: 'GIC' });
    expect(check({ ...good, GIC: 8 }, 'daily', 8)).toEqual({ ok: false, reason: 'GIC' });
  });
});

describe('spec 18.5 canonical JSON', () => {
  it('sorts keys at every level, keeps array order, drops undefined, refuses non-finite numbers', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: undefined, a: 'x' }], a: null })).toBe(
      '{"a":null,"b":[2,{"a":"x","d":1}]}',
    );
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});
