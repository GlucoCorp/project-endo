/** Whether this browser has a patient session (REQ-001). The page never sees her ids. */
export type SessionState =
  | { readonly kind: 'signed-in'; readonly appLock: boolean }
  /** Spec 10.1 app lock: she unlocks by signing in again with her passkey. */
  | { readonly kind: 'locked' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'error' };

export async function checkSession(fetchFn: typeof fetch): Promise<SessionState> {
  try {
    const res = await fetchFn('/v1/session', { credentials: 'same-origin' });
    if (res.status === 401) return { kind: 'signed-out' };
    if (!res.ok) return { kind: 'error' };
    const body = (await res.json().catch(() => null)) as {
      signed_in?: unknown;
      locked?: unknown;
      app_lock?: unknown;
    } | null;
    if (body?.signed_in !== true || typeof body.locked !== 'boolean') return { kind: 'error' };
    if (body.locked) return { kind: 'locked' };
    return { kind: 'signed-in', appLock: body.app_lock === true };
  } catch {
    return { kind: 'error' };
  }
}

const post = (fetchFn: typeof fetch, url: string, body: unknown, keepalive = false) =>
  fetchFn(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive,
  });

/** Ends this browser's session. True once the server has ended it. */
export async function signOut(fetchFn: typeof fetch): Promise<boolean> {
  try {
    return (await post(fetchFn, '/v1/session/sign-out', {})).status === 204;
  } catch {
    return false;
  }
}

/** Turns app lock on or off. True once the server has stored her choice. */
export async function setAppLock(fetchFn: typeof fetch, enabled: boolean): Promise<boolean> {
  try {
    return (await post(fetchFn, '/v1/session/app-lock', { enabled })).ok;
  } catch {
    return false;
  }
}

/**
 * She is leaving the app (hidden tab, switched app): lock it if she turned app lock on. Sent with
 * `keepalive` so it still goes out as the page is put away; the server decides.
 */
export function lockNow(fetchFn: typeof fetch): void {
  void post(fetchFn, '/v1/session/lock', {}, true).catch(() => undefined);
}

/** A full navigation: the BFF sends her to Keycloak and back. */
export const SIGN_IN_PATH = '/auth/sign-in';
