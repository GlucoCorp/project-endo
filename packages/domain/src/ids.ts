import { getRandomValues } from 'node:crypto';

/** An opaque identifier. Never derived from, or revealing, personal or health data (spec 9.1). */
export type OpaqueId = string & { readonly __brand: 'OpaqueId' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Generate a UUIDv7 (RFC 9562): 48-bit Unix millisecond timestamp followed by 74 random bits
 * from the platform CSPRNG. Time-ordered IDs keep B-tree indexes compact (spec 5.1).
 *
 * This is a layout of bytes, not a cryptographic primitive; randomness comes from node:crypto.
 */
export function uuidv7(nowMs: number = Date.now()): OpaqueId {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError('uuidv7: timestamp out of range');
  }
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // 48-bit big-endian timestamp: high 16 bits, then low 32 bits.
  const view = new DataView(bytes.buffer);
  view.setUint16(0, Math.floor(nowMs / 2 ** 32));
  view.setUint32(2, nowMs >>> 0);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as OpaqueId;
}

export function isUuidV7(value: string): value is OpaqueId {
  return UUID_V7_RE.test(value);
}

/** Any RFC 9562 UUID (lower-case). Used to validate opaque IDs arriving at boundaries. */
export function isUuid(value: string): value is OpaqueId {
  return UUID_RE.test(value);
}
