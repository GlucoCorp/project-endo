/**
 * Drafting a treatment episode from the clinic portal (REQ-002), over a fetch seam so it is tested
 * without a DOM. The POST carries this session's CSRF token and an Idempotency-Key, so a retried
 * click never drafts twice.
 */
export interface Treatment {
  readonly system: string;
  readonly code: string;
  readonly display: string;
  readonly adherence_mode: string;
}
export interface Catalogue {
  readonly draft: boolean;
  readonly treatments: readonly Treatment[];
}
export interface SharingPatient {
  readonly id: string;
  readonly enrolled_at: string;
}
export interface EpisodeSummary {
  readonly id: string;
  readonly status: string;
  readonly treatment: { readonly display: string | null; readonly code: string };
  readonly dose_text: string;
  readonly start_date: string;
  readonly review_date: string;
  readonly check_ins: readonly unknown[];
  readonly red_flags: readonly {
    readonly flags: readonly string[];
    readonly recorded_at: string;
  }[];
}
export interface DraftInput {
  readonly treatment: { readonly system: string; readonly code: string };
  readonly dose_text: string;
  readonly start_date: string;
  readonly review_interval_weeks: number;
}
export type DraftResult =
  | { readonly kind: 'drafted' }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'error' };

const getJson = async <T>(f: typeof fetch, url: string): Promise<T | null> => {
  try {
    const res = await f(url, { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};

export class Drafting {
  readonly #fetch: typeof fetch;
  readonly #csrf: () => string;

  constructor(f: typeof fetch, csrf: () => string) {
    this.#fetch = f;
    this.#csrf = csrf;
  }

  catalogue(): Promise<Catalogue | null> {
    return getJson<Catalogue>(this.#fetch, '/v1/catalogue');
  }

  async patients(): Promise<readonly SharingPatient[] | null> {
    return (
      (await getJson<{ patients: SharingPatient[] }>(this.#fetch, '/v1/patients'))?.patients ?? null
    );
  }

  async episodes(patientId: string): Promise<readonly EpisodeSummary[] | null> {
    return (
      (
        await getJson<{ episodes: EpisodeSummary[] }>(
          this.#fetch,
          `/v1/patients/${encodeURIComponent(patientId)}/episodes`,
        )
      )?.episodes ?? null
    );
  }

  /** Checks the input first; nothing is sent for an out-of-range interval or empty dose. */
  async draft(patientId: string, input: DraftInput, key: string): Promise<DraftResult> {
    if (
      input.dose_text.trim().length === 0 ||
      !Number.isInteger(input.review_interval_weeks) ||
      input.review_interval_weeks < 4 ||
      input.review_interval_weeks > 26 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.start_date)
    )
      return { kind: 'refused', code: 'episode.invalid_input' };
    try {
      const res = await this.#fetch(`/v1/patients/${encodeURIComponent(patientId)}/episodes`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': this.#csrf(),
          'idempotency-key': key,
        },
        body: JSON.stringify({ ...input, dose_text: input.dose_text.trim() }),
      });
      if (res.ok) return { kind: 'drafted' };
      if (res.status >= 500) return { kind: 'error' };
      const body = (await res.json().catch(() => null)) as { type?: unknown } | null;
      const code =
        typeof body?.type === 'string' ? (/([a-z_]+\.[a-z_.]+)$/.exec(body.type)?.[1] ?? '') : '';
      return { kind: 'refused', code };
    } catch {
      return { kind: 'error' };
    }
  }
}
