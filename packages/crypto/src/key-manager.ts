/**
 * Logical key names from spec 11.1. Each maps to a customer-managed KMS key per region.
 * Application code only ever names a key; it never sees master key material (spec 11.2).
 */
export type KeyRef =
  'kms/identity' | 'kms/clinical' | 'kms/audit' | 'kms/objects' | 'kms/analytics' | 'kms/backup';

export interface DataKey {
  /** 32-byte AES-256 key. Callers must zero it (`fill(0)`) as soon as they are done. */
  readonly plaintext: Uint8Array;
  /** The same key wrapped (encrypted) by the master key. Safe to store. */
  readonly wrapped: Uint8Array;
}

/**
 * Cloud-neutral key management interface (spec 8.1, 17.3). Implementations: AWS KMS, HashiCorp
 * Vault Transit (Kenya/Rwanda), and `DevKeyManager` for local development and tests only.
 */
export interface KeyManager {
  generateDataKey(keyRef: KeyRef): Promise<DataKey>;
  unwrapDataKey(keyRef: KeyRef, wrapped: Uint8Array): Promise<Uint8Array>;
}
