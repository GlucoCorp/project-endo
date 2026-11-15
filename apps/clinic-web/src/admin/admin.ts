/**
 * Organisation admin (REQ-010; spec 21.8) over a fetch seam, tested without a DOM. Every write
 * carries the CSRF token and an Idempotency-Key, as the clinic BFF requires.
 */
export interface Settings {
  readonly default_review_interval_weeks: number | null;
  readonly languages: readonly string[];
  readonly emergency_number: string | null;
  readonly updated_at?: string | null;
}

export interface Member {
  readonly clinician_id: string;
  readonly role: 'clinician' | 'org_admin';
  readonly active: boolean;
  readonly since: string;
  readonly you: boolean;
}

export type Result<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'error' };

/** Turns the form's text into settings, or null if a value cannot be right. */
export function parseSettings(
  interval: string,
  languages: string,
  emergency: string,
): Settings | null {
  const weeks = interval === '' ? null : Number(interval);
  if (weeks !== null && (!Number.isInteger(weeks) || weeks < 4 || weeks > 26)) return null;
  const langs = languages
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const code = (l: string) => /^[a-z]{2}$/.test(l) || /^[a-z]{2}-[A-Z]{2}$/.test(l);
  if (langs.length === 0 || !langs.every(code)) return null;
  const number = emergency.trim();
  if (number !== '' && !/^[0-9]{2,15}$/.test(number)) return null;
  return {
    default_review_interval_weeks: weeks,
    languages: [...new Set(langs)],
    emergency_number: number === '' ? null : number,
  };
}

export class Admin {
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

  async #post<T>(url: string, body: unknown): Promise<Result<T>> {
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': this.#csrf(),
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return { kind: 'ok', value: (await res.json()) as T };
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

  settings(): Promise<Settings | null> {
    return this.#get<Settings>('/v1/org/settings');
  }

  saveSettings(s: Settings): Promise<Result<Settings>> {
    return this.#post<Settings>('/v1/org/settings', {
      default_review_interval_weeks: s.default_review_interval_weeks,
      languages: s.languages,
      emergency_number: s.emergency_number,
    });
  }

  async members(): Promise<readonly Member[] | null> {
    return (await this.#get<{ clinicians: Member[] }>('/v1/org/clinicians'))?.clinicians ?? null;
  }

  change(id: string, role: Member['role'], active: boolean): Promise<Result<unknown>> {
    return this.#post(`/v1/org/clinicians/${encodeURIComponent(id)}`, { role, active });
  }
}
