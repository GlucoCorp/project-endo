/**
 * Opened from a record system (SMART App Launch, M7, spec 16.2). The BFF put an opaque handle in
 * the fragment; this reads it once, asks which patient it is for, and links it when needed.
 */
export type LaunchContext =
  | { readonly linked: true; readonly patient_id: string }
  | { readonly linked: false }
  | 'expired'
  | 'error';

/** The launch handle from `#launch=...`, or null. */
export function launchHandle(hash: string): string | null {
  const m = /^#launch=([A-Za-z0-9_-]{43})$/.exec(hash);
  return m?.[1] ?? null;
}

const post = (f: typeof fetch, url: string, csrf: string, body: object) =>
  f(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });

export async function launchContext(
  f: typeof fetch,
  csrf: string,
  handle: string,
): Promise<LaunchContext> {
  try {
    const res = await post(f, '/v1/smart/context', csrf, { handle });
    if (res.status === 404) return 'expired';
    if (!res.ok) return 'error';
    return (await res.json()) as LaunchContext;
  } catch {
    return 'error';
  }
}

/** Links the record-system patient to one of hers: 'exists' if it was linked meanwhile. */
export async function linkLaunch(
  f: typeof fetch,
  csrf: string,
  handle: string,
  patientId: string,
): Promise<'linked' | 'exists' | 'expired' | 'error'> {
  try {
    const res = await post(f, '/v1/smart/link', csrf, { handle, patient_id: patientId });
    if (res.status === 201) return 'linked';
    if (res.status === 409) return 'exists';
    if (res.status === 404) return 'expired';
    return 'error';
  } catch {
    return 'error';
  }
}
