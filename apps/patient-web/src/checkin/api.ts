/**
 * Her episodes and check-ins, through the patient BFF (M2: REQ-002, REQ-003, REQ-007). Every
 * state change carries an Idempotency-Key, so a retry (or an offline replay) never saves twice.
 * Nothing here logs, and nothing puts an answer in a URL.
 */
export interface EpisodeView {
  readonly id: string;
  readonly status: 'draft' | 'active' | 'in_review' | 'closed';
  readonly treatment: { readonly display: string | null; readonly code: string };
  readonly dose_text: string;
  readonly adherence_mode: 'daily' | 'device_or_injection';
  readonly start_date: string;
  readonly review_date: string;
  readonly review_interval_weeks: number;
  readonly goal: { readonly template_code: string | null; readonly text: string | null } | null;
  readonly check_ins: readonly { readonly week_index: number; readonly is_late: boolean }[];
  readonly open_weeks: readonly number[];
}

export interface CheckInContent {
  readonly draft: boolean;
  readonly instrument_version: string;
  readonly text: Readonly<Record<string, string>>;
  readonly options: {
    readonly Q2: readonly string[];
    readonly Q3: readonly string[];
    readonly Q5: readonly string[];
    readonly Q6: readonly string[];
    readonly Q8: readonly string[];
  };
  readonly review_weeks: readonly number[];
  readonly red_flags: readonly {
    readonly id: string;
    readonly text: string;
    readonly routes_to: string | null;
  }[];
  readonly goals: readonly { readonly code: string; readonly text: string }[];
}

export type SendResult =
  | { readonly kind: 'ok'; readonly body: Record<string, unknown> }
  /** The server refused it for good (wrong week, too late, invalid): do not retry. */
  | { readonly kind: 'refused'; readonly code: string }
  /** Signed out or locked: keep it, retry after she signs in. */
  | { readonly kind: 'signed-out' }
  /** No network or the service is down: keep it, retry later. */
  | { readonly kind: 'offline' };

const codeOf = async (res: Response) => {
  const body = (await res.json().catch(() => null)) as { type?: unknown } | null;
  return typeof body?.type === 'string' ? (/([a-z_]+\.[a-z_.]+)$/.exec(body.type)?.[1] ?? '') : '';
};

export async function getJson<T>(
  fetchFn: typeof fetch,
  url: string,
): Promise<T | 'signed-out' | null> {
  try {
    const res = await fetchFn(url, { credentials: 'same-origin' });
    if (res.status === 401) return 'signed-out';
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** POSTs a JSON body with an Idempotency-Key and classifies the outcome for retry decisions. */
export async function send(
  fetchFn: typeof fetch,
  url: string,
  key: string,
  body: unknown,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.ok) {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: 'ok', body: b };
  }
  if (res.status === 401) return { kind: 'signed-out' };
  if ([400, 403, 404, 409, 415, 422].includes(res.status))
    return { kind: 'refused', code: await codeOf(res) };
  return { kind: 'offline' };
}

export const paths = {
  episodes: '/v1/me/episodes',
  content: '/v1/me/checkin-content',
  confirm: (id: string) => `/v1/episodes/${encodeURIComponent(id)}/confirm`,
  checkIn: (id: string) => `/v1/episodes/${encodeURIComponent(id)}/checkins`,
  redFlags: (id: string) => `/v1/episodes/${encodeURIComponent(id)}/red-flags`,
} as const;

/** Her time zone from the device (sent when she confirms; her weeks follow it). */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
