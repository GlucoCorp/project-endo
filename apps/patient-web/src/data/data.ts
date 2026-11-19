/**
 * Her data rights (REQ-009; spec 13.4, 21.7 screen 9): download her record, delete her account.
 * Over a fetch seam so it is tested without a DOM.
 */
export type Deletion =
  | { readonly status: 'none' }
  | {
      readonly status: 'scheduled' | 'cancelled' | 'erased';
      readonly requested_at: string;
      readonly due_at: string;
    };

/** Spec 10.1: the BFF wants a fresh sign-in (her passkey) before this. */
export type Reauth = 'reauth';

/** Whether a refusal asks her to sign in again (spec 10.1). */
export async function isReauth(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const b = (await res.json().catch(() => null)) as { type?: unknown } | null;
  return typeof b?.type === 'string' && b.type.endsWith('authn.reauth_required');
}

const post = (f: typeof fetch, url: string) =>
  f(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

export async function deletionStatus(f: typeof fetch): Promise<Deletion | null> {
  try {
    const res = await f('/v1/me/deletion', { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as Deletion) : null;
  } catch {
    return null;
  }
}

/** Asks for deletion in 14 days (asking again returns the same request). */
export async function requestDeletion(f: typeof fetch): Promise<Deletion | Reauth | 'error'> {
  try {
    const res = await post(f, '/v1/me/deletion');
    if (res.ok) return (await res.json()) as Deletion;
    return (await isReauth(res)) ? 'reauth' : 'error';
  } catch {
    return 'error';
  }
}

export async function cancelDeletion(f: typeof fetch): Promise<Deletion | 'error'> {
  try {
    const res = await post(f, '/v1/me/deletion/cancel');
    return res.ok ? ((await res.json()) as Deletion) : 'error';
  } catch {
    return 'error';
  }
}

/** Her FHIR Bundle as a file (never cached). The page saves it with a download link. */
export async function exportRecord(f: typeof fetch): Promise<Blob | Reauth | 'error'> {
  try {
    const res = await post(f, '/v1/me/export');
    if (res.ok) return await res.blob();
    return (await isReauth(res)) ? 'reauth' : 'error';
  } catch {
    return 'error';
  }
}
