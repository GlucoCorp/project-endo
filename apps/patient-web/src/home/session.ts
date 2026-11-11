/** Whether this browser has a patient session (REQ-001). The page never sees her ids. */
export type SessionState = 'signed-in' | 'signed-out' | 'error';

export async function checkSession(fetchFn: typeof fetch): Promise<SessionState> {
  try {
    const res = await fetchFn('/v1/session', { credentials: 'same-origin' });
    if (res.status === 401) return 'signed-out';
    if (!res.ok) return 'error';
    const body = (await res.json().catch(() => null)) as { signed_in?: unknown } | null;
    return body?.signed_in === true ? 'signed-in' : 'error';
  } catch {
    return 'error';
  }
}

/** Ends this browser's session. True once the server has ended it. */
export async function signOut(fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/v1/session/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** A full navigation: the BFF sends her to Keycloak and back. */
export const SIGN_IN_PATH = '/auth/sign-in';
