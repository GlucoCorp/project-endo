/**
 * The idempotency key of the red-flag report that belongs to a check-in (spec 6.3, REQ-007).
 *
 * Her app reports red flags on their own as soon as she answers them, and again inside the
 * check-in. Both carry the same key, derived here from the check-in's key and the set of flags, so
 * the server records the event once whichever arrives first, and a different set of flags (she
 * added one) is a new event, never a conflict that could lose it. SHA-256 (WebCrypto, in browsers and Node alike) of a
 * domain-separated string, shaped as a UUID (version 8, RFC 9562 variant).
 */
export async function redFlagKeyFor(checkInKey: string, flags: readonly string[]): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(checkInKey))
    throw new TypeError('check-in key must be a lowercase UUID');
  if (!flags.every((f) => /^RF[0-9]{1,2}$/.test(f))) throw new TypeError('red flag codes');
  const set = [...new Set(flags)].sort().join(',');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`endo:red_flags:v2:${checkInKey}:${set}`),
  );
  const raw = Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  // Version 8 in the 13th hex digit; the RFC 9562 variant (10xx) in the 17th.
  const variant = ((parseInt(raw.charAt(16), 16) & 0x3) | 0x8).toString(16);
  const hex = `${raw.slice(0, 12)}8${raw.slice(13, 16)}${variant}${raw.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
