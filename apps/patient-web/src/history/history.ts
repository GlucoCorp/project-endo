/**
 * Her treatment history, sharing and access log (REQ-008; spec 13.3, 21.7 screens 7 and 8), and
 * a receiver's view of a share link. Over a fetch seam so it is tested without a DOM.
 */
export interface TreatmentCard {
  readonly id: string;
  readonly status: string;
  readonly treatment: { readonly code: string; readonly display: string | null };
  readonly dose_text: string;
  readonly start_date: string;
  readonly review_date: string;
  readonly review_interval_weeks: number;
  readonly goal: string | null;
  readonly decision: string | null;
  readonly weeks: readonly {
    readonly week_index: number;
    readonly is_late: boolean;
    readonly answers: unknown;
  }[];
}

export interface Summary {
  readonly treatments: readonly TreatmentCard[];
  readonly expires_at?: string;
}

export interface LinkRow {
  readonly id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly active: boolean;
}

export interface AccessEvent {
  readonly at: string;
  readonly role: string;
  readonly action: string;
  readonly purpose: string;
  readonly outcome: string;
}

const get = async <T>(f: typeof fetch, url: string): Promise<T | null> => {
  try {
    const res = await f(url, { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};

export const history = (f: typeof fetch) => get<Summary>(f, '/v1/me/history');
export const shareLinks = async (f: typeof fetch) =>
  (await get<{ links: LinkRow[] }>(f, '/v1/me/share-links'))?.links ?? null;
export const accessLog = async (f: typeof fetch) =>
  (await get<{ events: AccessEvent[] }>(f, '/v1/me/access-log'))?.events ?? null;

/** Makes a link; the token comes back once, so the page shows the full link once. */
export async function createShareLink(
  f: typeof fetch,
  days: number,
  key: string,
  origin: string,
): Promise<{ readonly url: string; readonly expiresAt: string } | 'already' | 'error'> {
  try {
    const res = await f('/v1/me/share-links', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ days }),
    });
    if (res.status === 409) return 'already';
    if (!res.ok) return 'error';
    const b = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof b.token !== 'string' || typeof b.expires_at !== 'string') return 'error';
    // The token goes in the fragment: browsers never send it to a server or keep it in logs.
    return { url: `${origin}/shared#${b.token}`, expiresAt: b.expires_at };
  } catch {
    return 'error';
  }
}

export async function stopSharing(f: typeof fetch, id: string): Promise<boolean> {
  try {
    const res = await f(`/v1/me/share-links/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** Reads the token from the link's fragment (then the page removes it from the address bar). */
export function tokenFrom(hash: string): string | null {
  const t = hash.replace(/^#/, '');
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export async function viewShared(
  f: typeof fetch,
  token: string,
): Promise<Summary | 'invalid' | 'error'> {
  try {
    const res = await f('/v1/shared/view', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.status === 404 || res.status === 400) return 'invalid';
    if (!res.ok) return 'error';
    return (await res.json()) as Summary;
  } catch {
    return 'error';
  }
}
