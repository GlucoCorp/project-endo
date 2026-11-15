import { createHash } from 'node:crypto';
import { CLINICAL_TODO_MARKER, ClinicalNotReadyError } from './clinical-gate.ts';
import { isDeployedEnvironment, type EnvironmentName } from './load.ts';
import { SYNTHETIC_GOALS, SYNTHETIC_SIDE_EFFECTS, SYNTHETIC_TREATMENTS } from './synthetic.ts';

/**
 * Clinical content read by the services (spec 6, REQ-002): the check-in instrument, the treatment
 * catalogue and the suggested goals, from the clinician-owned JSON files in `clinical/` (ADR-0027).
 *
 * In staging and production every `TODO_CLINICAL` refuses startup. In local, dev and test, an
 * unfinished list is replaced by an obviously synthetic placeholder (`synthetic.ts`) and the
 * content is marked `draft`, so screens can show that nothing here is approved.
 */
export type AdherenceMode = 'daily' | 'device_or_injection';

export interface Treatment {
  readonly system: string;
  readonly code: string;
  readonly display: string;
  readonly adherenceMode: AdherenceMode;
}

export interface GoalTemplate {
  readonly code: string;
  readonly text: string;
}

export interface RedFlagItem {
  readonly id: string;
  readonly text: string;
  /** Where this flag routes beyond the urgent screen, e.g. crisis support for self-harm. */
  readonly routesTo: string | null;
}

export interface Instrument {
  readonly version: string;
  /** Some content is unapproved (only possible outside staging and production). */
  readonly draft: boolean;
  /** SHA-256 of the file as read: recorded so a verdict names exactly what was asked (18.5). */
  readonly digest: string;
  /** Draft wording per question id (Q1-Q8, GIC), for development screens only. */
  readonly text: Readonly<Record<string, string>>;
  readonly options: {
    readonly Q2: readonly string[];
    readonly Q3: readonly string[];
    readonly Q5: readonly string[];
    readonly Q6: readonly string[];
    readonly Q8: readonly string[];
  };
  /** The bleeding scale (Q4) is accepted only once approved. */
  readonly bleedingScaleApproved: boolean;
  readonly reviewWeeks: readonly number[];
  readonly redFlags: readonly RedFlagItem[];
}

export interface ClinicalContent {
  readonly instrument: Instrument;
  readonly treatments: readonly Treatment[];
  readonly goals: readonly GoalTemplate[];
  readonly draft: boolean;
}

export class ClinicalContentError extends Error {
  constructor(file: string, what: string) {
    super(`Clinical content ${file}: ${what}`);
    this.name = 'ClinicalContentError';
  }
}

const isTodo = (v: unknown) => v === CLINICAL_TODO_MARKER;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x))
    ? (v as string[])
    : null;

function parse(file: string, text: string): Record<string, unknown> {
  try {
    return obj(JSON.parse(text));
  } catch {
    throw new ClinicalContentError(file, 'not valid JSON');
  }
}

/** Loads and checks the three files. Throws on malformed content, and on any TODO when deployed. */
export function loadClinicalContent(
  env: EnvironmentName,
  files: { readonly instrument: string; readonly treatments: string; readonly goals: string },
): ClinicalContent {
  const deployed = isDeployedEnvironment(env);
  for (const text of Object.values(files)) {
    const n = text.split(CLINICAL_TODO_MARKER).length - 1;
    if (deployed && n > 0) throw new ClinicalNotReadyError(env, n);
  }
  let draft = false;
  const pick = <T>(
    value: unknown,
    synthetic: T,
    check: (v: unknown) => T | null,
    what: string,
    file: string,
  ): T => {
    if (isTodo(value)) {
      draft = true;
      return synthetic;
    }
    const ok = check(value);
    if (ok === null) throw new ClinicalContentError(file, what);
    return ok;
  };

  const ins = parse('instrument', files.instrument);
  const version = ins['instrument_version'];
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    throw new ClinicalContentError('instrument', 'instrument_version');
  if (isTodo(ins['approved_by'])) draft = true;
  const questions = Array.isArray(ins['weekly_questions'])
    ? (ins['weekly_questions'] as unknown[]).map(obj)
    : [];
  const ids = questions.map((q) => q['id']);
  if (JSON.stringify(ids) !== JSON.stringify(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']))
    throw new ClinicalContentError('instrument', 'weekly questions must be Q1-Q8 in order');
  const q = (id: string) => questions.find((x) => x['id'] === id) ?? {};
  const text: Record<string, string> = {};
  for (const x of questions)
    if (typeof x['draft_text'] === 'string') text[x['id'] as string] = x['draft_text'];
  const variants = obj(q('Q7')['variants']);
  if (typeof variants['device_or_injection'] === 'string')
    text['Q7_device_or_injection'] = variants['device_or_injection'];
  const review = obj(ins['review_week_additions']);
  const gic = obj(review['global_impression_of_change']);
  if (typeof gic['draft_text'] === 'string') text['GIC'] = gic['draft_text'];
  const reviewWeeks = Array.isArray(review['weeks']) ? (review['weeks'] as unknown[]) : [];
  if (!reviewWeeks.every((w) => Number.isInteger(w) && (w as number) >= 1 && (w as number) <= 26))
    throw new ClinicalContentError('instrument', 'review weeks');
  const flagsBlock = obj(ins['red_flags']);
  if (isTodo(flagsBlock['final_list'])) draft = true;
  const rawFlags = Array.isArray(flagsBlock['final_list'])
    ? (flagsBlock['final_list'] as unknown[])
    : Array.isArray(flagsBlock['drafts'])
      ? (flagsBlock['drafts'] as unknown[])
      : [];
  const redFlags = rawFlags.map(obj).map((f) => {
    if (
      typeof f['id'] !== 'string' ||
      !/^RF[0-9]{1,2}$/.test(f['id']) ||
      typeof f['draft_text'] !== 'string'
    )
      throw new ClinicalContentError('instrument', 'red flag item');
    return {
      id: f['id'],
      text: f['draft_text'],
      routesTo: typeof f['routes_to'] === 'string' ? f['routes_to'] : null,
    };
  });
  // Red flags always win: an instrument without them is never usable.
  if (redFlags.length === 0) throw new ClinicalContentError('instrument', 'no red flags');
  const opt = (id: string) =>
    pick(q(id)['options'], null as unknown as string[], strings, `${id} options`, 'instrument');
  const instrument: Instrument = {
    version,
    draft: false,
    digest: createHash('sha256').update(files.instrument).digest('hex'),
    text,
    options: {
      Q2: opt('Q2'),
      Q3: opt('Q3'),
      Q5: pick(
        q('Q5')['options'],
        [...SYNTHETIC_SIDE_EFFECTS],
        strings,
        'Q5 options',
        'instrument',
      ),
      Q6: opt('Q6'),
      Q8: opt('Q8'),
    },
    bleedingScaleApproved: !isTodo(q('Q4')['scale']) && q('Q4')['scale'] !== undefined,
    reviewWeeks: reviewWeeks as number[],
    redFlags,
  };
  const { Q2, Q3, Q6, Q8 } = instrument.options;
  if (![Q2, Q3, Q6, Q8].every((o) => Array.isArray(o)))
    throw new ClinicalContentError('instrument', 'Q2, Q3, Q6 and Q8 options must be listed');

  const cat = parse('treatments', files.treatments);
  const treatments = pick(
    cat['entries'],
    SYNTHETIC_TREATMENTS.map((t) => ({ ...t })) as Treatment[],
    (v) => {
      if (!Array.isArray(v) || v.length === 0) return null;
      const out = v.map(obj).map((t) => ({
        system: t['system'],
        code: t['code'],
        display: t['display'],
        adherenceMode: t['adherence_mode'],
      }));
      return out.every(
        (t) =>
          typeof t.system === 'string' &&
          typeof t.code === 'string' &&
          /^[A-Za-z0-9.-]{1,32}$/.test(t.code) &&
          typeof t.display === 'string' &&
          (t.adherenceMode === 'daily' || t.adherenceMode === 'device_or_injection'),
      )
        ? (out as Treatment[])
        : null;
    },
    'treatment entries',
    'treatments',
  );
  if (isTodo(cat['approved_by'])) draft = true;

  const gl = parse('goals', files.goals);
  const goals = pick(
    gl['templates'],
    SYNTHETIC_GOALS.map((g) => ({ ...g })) as GoalTemplate[],
    (v) => {
      if (!Array.isArray(v) || v.length === 0) return null;
      const out = v.map(obj).map((g) => ({ code: g['code'], text: g['text'] }));
      return out.every(
        (g) =>
          typeof g.code === 'string' &&
          /^[a-z][a-z0-9_]{0,63}$/.test(g.code) &&
          typeof g.text === 'string' &&
          g.text.length <= 140,
      )
        ? (out as GoalTemplate[])
        : null;
    },
    'goal templates',
    'goals',
  );
  if (isTodo(gl['approved_by'])) draft = true;
  // Anything unfinished anywhere in the three files makes the content a draft.
  if (Object.values(files).some((t) => t.includes(CLINICAL_TODO_MARKER))) draft = true;

  return { instrument: { ...instrument, draft }, treatments, goals, draft };
}

/** One week's answers, validated and normalised (arrays sorted), ready to store and hash. */
export type CheckInAnswers = Readonly<Record<string, number | string | readonly string[]>>;

export type AnswerCheck =
  | { readonly ok: true; readonly answers: CheckInAnswers; readonly redFlags: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Checks a week's answers against the instrument (spec 6), for this episode's adherence mode and
 * week. Strict: unknown keys, missing required answers and values outside the lists are refused.
 * The red-flag screen is always part of it (6.3): `red_flags` must be present, possibly empty.
 */
export function validateAnswers(
  instrument: Instrument,
  adherenceMode: AdherenceMode,
  weekIndex: number,
  input: unknown,
): AnswerCheck {
  const a = new Map(Object.entries(obj(input)));
  const fail = (reason: string): AnswerCheck => ({ ok: false, reason });
  const allowed = new Set(['Q1', 'Q2', 'Q3', 'Q5', 'Q6', 'Q7', 'Q8', 'GIC', 'red_flags']);
  if (instrument.bleedingScaleApproved) allowed.add('Q4');
  for (const k of a.keys()) if (!allowed.has(k)) return fail(`unexpected ${k}`);
  const out = new Map<string, number | string | readonly string[]>();

  const flags = a.get('red_flags');
  const flagIds = new Set(instrument.redFlags.map((f) => f.id));
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string' && flagIds.has(f)))
    return fail('red_flags');
  const redFlags = [...new Set(flags as string[])].sort();
  out.set('red_flags', redFlags);

  const int = (k: string, min: number, max: number) => {
    const v = a.get(k);
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) return false;
    out.set(k, v as number);
    return true;
  };
  const one = (k: string, options: readonly string[]) => {
    const v = a.get(k);
    if (typeof v !== 'string' || !options.includes(v)) return false;
    out.set(k, v);
    return true;
  };
  const many = (k: string, options: readonly string[], none: string | null) => {
    const v = a.get(k);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && options.includes(x)))
      return false;
    const set = [...new Set(v as string[])].sort();
    if (none && set.includes(none) && set.length > 1) return false; // "none" is exclusive
    out.set(k, set);
    return set;
  };

  if (!int('Q1', 0, 10)) return fail('Q1');
  if (!one('Q2', instrument.options.Q2)) return fail('Q2');
  if (!one('Q3', instrument.options.Q3)) return fail('Q3');
  const effects = many('Q5', instrument.options.Q5, null);
  if (!effects) return fail('Q5');
  if (effects.length > 0 ? !one('Q6', instrument.options.Q6) : a.get('Q6') !== undefined)
    return fail('Q6');
  if (adherenceMode === 'daily') {
    if (!int('Q7', 0, 7)) return fail('Q7');
  } else if (!one('Q7', ['yes', 'no'])) return fail('Q7');
  const barriers = many('Q8', instrument.options.Q8, 'none');
  if (!barriers || barriers.length === 0) return fail('Q8');
  const reviewWeek = instrument.reviewWeeks.includes(weekIndex);
  if (reviewWeek ? !int('GIC', 1, 7) : a.get('GIC') !== undefined) return fail('GIC');
  return { ok: true, answers: Object.fromEntries(out), redFlags };
}

/** Canonical JSON (sorted keys, no whitespace) for hashing and signing (spec 18.5). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError('non-finite number');
  return JSON.stringify(value);
}
