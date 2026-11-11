/**
 * Her email for the sign-in fallback (spec 10.1; ADR-0026): add an address, then confirm it with
 * the code sent to it. The page keeps only the request id between the two steps.
 */
const post = (fetchFn: typeof fetch, url: string, body: unknown) =>
  fetchFn(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Sends a code to the address: the request id, or 'error'. */
export async function requestEmailCode(fetchFn: typeof fetch, address: string): Promise<string> {
  try {
    const res = await post(fetchFn, '/v1/settings/email', { address: address.trim() });
    if (res.status !== 202) return 'error';
    const id = ((await res.json().catch(() => null)) as { request_id?: unknown } | null)
      ?.request_id;
    return typeof id === 'string' ? id : 'error';
  } catch {
    return 'error';
  }
}

export type ConfirmResult = 'confirmed' | 'wrong' | 'error';

export async function confirmEmailCode(
  fetchFn: typeof fetch,
  requestId: string,
  code: string,
): Promise<ConfirmResult> {
  if (!/^[0-9]{6}$/.test(code.trim())) return 'wrong';
  try {
    const res = await post(fetchFn, '/v1/settings/email/confirm', {
      request_id: requestId,
      code: code.trim(),
    });
    if (res.status === 204) return 'confirmed';
    return res.status === 400 ? 'wrong' : 'error';
  } catch {
    return 'error';
  }
}
