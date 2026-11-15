/**
 * The clinician desk's calls (M4: REQ-005, REQ-006; spec 21.8), over a fetch seam so they are
 * tested without a DOM. State changes carry this session's CSRF token and an Idempotency-Key.
 */
export interface QueueRow {
  readonly episode_id: string;
  readonly patient_id: string;
  readonly treatment: { readonly code: string; readonly display: string | null };
  readonly dose_text: string;
  readonly review_date: string;
  readonly overdue: boolean;
  readonly week: number;
  readonly check_ins: number;
  readonly red_flags: number;
}

export interface Review {
  readonly verdicts: 'shadow';
  readonly episode: {
    readonly id: string;
    readonly status: string;
    readonly treatment: { readonly code: string; readonly display: string | null };
    readonly dose_text: string;
    readonly adherence_mode: string;
    readonly start_date: string;
    readonly review_date: string;
    readonly review_interval_weeks: number;
    readonly goal: string | null;
  };
  readonly weeks: readonly {
    readonly week_index: number;
    readonly is_late: boolean;
    readonly answers: unknown;
  }[];
  readonly red_flags: readonly {
    readonly flags: readonly string[];
    readonly recorded_at: string;
  }[];
  readonly history: readonly {
    readonly id: string;
    readonly status: string;
    readonly treatment: { readonly code: string; readonly display: string | null };
    readonly dose_text: string;
    readonly start_date: string;
    readonly review_date: string;
  }[];
  readonly decisions: readonly {
    readonly episode_id: string;
    readonly decision: string;
    readonly note: string | null;
    readonly decided_at: string;
  }[];
  readonly guideline_options: readonly unknown[];
  readonly decision_options: readonly Decision[];
}

export type Decision = 'continue' | 'switch' | 'add' | 'refer' | 'stop';
export const DECISIONS: readonly Decision[] = ['continue', 'switch', 'add', 'refer', 'stop'];
export const PROCEDURES = [
  'hysterectomy',
  'myomectomy',
  'ovarian_cystectomy',
  'adenomyomectomy',
  'ablation',
] as const;

export interface TreatmentChoice {
  readonly treatment: { readonly system: string; readonly code: string };
  readonly dose_text: string;
  readonly start_date: string;
  readonly review_interval_weeks: number;
}

export type Result =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'error' };

export type QueueFilter = 'all' | 'this_week' | 'overdue';

/** Spec 21.8: filter the queue (red flags stay pinned by the API's order). */
export function filterQueue(
  rows: readonly QueueRow[],
  filter: QueueFilter,
  today: string,
  search: string,
) {
  const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const q = search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'all' ||
        (filter === 'overdue' && r.overdue) ||
        (filter === 'this_week' && r.review_date >= today && r.review_date < weekEnd)) &&
      (q === '' ||
        r.patient_id.slice(-6).includes(q) ||
        (r.treatment.display ?? r.treatment.code).toLowerCase().includes(q)),
  );
}

/** J/K move, Enter opens (spec 21.8). Returns the new index, or 'open'. */
export function queueKey(key: string, index: number, length: number): number | 'open' | null {
  if (length === 0) return null;
  if (key === 'j' || key === 'ArrowDown') return Math.min(index + 1, length - 1);
  if (key === 'k' || key === 'ArrowUp') return Math.max(index - 1, 0);
  if (key === 'Enter') return 'open';
  return null;
}

/** 1-5 choose a decision (spec 21.8). */
export function decisionKey(key: string): Decision | null {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? (DECISIONS[n - 1] ?? null) : null;
}

export class Desk {
  readonly #fetch: typeof fetch;
  readonly #csrf: () => string;

  constructor(f: typeof fetch, csrf: () => string) {
    this.#fetch = f;
    this.#csrf = csrf;
  }

  async #get<T>(url: string): Promise<T | null> {
    try {
      const res = await this.#fetch(url, { credentials: 'same-origin' });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async #post(url: string, body: unknown, key: string): Promise<Result> {
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': this.#csrf(),
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return { kind: 'ok', body: await res.json().catch(() => null) };
      if (res.status >= 500) return { kind: 'error' };
      const b = (await res.json().catch(() => null)) as { type?: unknown } | null;
      return {
        kind: 'refused',
        code: typeof b?.type === 'string' ? (/([a-z_]+\.[a-z_.]+)$/.exec(b.type)?.[1] ?? '') : '',
      };
    } catch {
      return { kind: 'error' };
    }
  }

  async queue(): Promise<readonly QueueRow[] | null> {
    return (await this.#get<{ items: QueueRow[] }>('/v1/reviews/queue'))?.items ?? null;
  }

  review(patientId: string, episodeId: string): Promise<Review | null> {
    return this.#get<Review>(
      `/v1/patients/${encodeURIComponent(patientId)}/episodes/${encodeURIComponent(episodeId)}/review`,
    );
  }

  decide(
    patientId: string,
    episodeId: string,
    decision: Decision,
    note: string,
    choice: { next?: TreatmentChoice; added?: TreatmentChoice },
    key: string,
  ): Promise<Result> {
    return this.#post(
      `/v1/patients/${encodeURIComponent(patientId)}/episodes/${encodeURIComponent(episodeId)}/decision`,
      {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(decision === 'switch' && choice.next ? { next: choice.next } : {}),
        ...(decision === 'add' && choice.added ? { added: choice.added } : {}),
      },
      key,
    );
  }

  surgeryPreview(patientId: string, procedure: string, key: string): Promise<Result> {
    return this.#post(
      `/v1/patients/${encodeURIComponent(patientId)}/surgery-checks/preview`,
      { procedure },
      key,
    );
  }

  surgeryRecord(patientId: string, procedure: string, key: string): Promise<Result> {
    return this.#post(
      `/v1/patients/${encodeURIComponent(patientId)}/surgery-checks`,
      { procedure, discussed_with_patient: true },
      key,
    );
  }
}
