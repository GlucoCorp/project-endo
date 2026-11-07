/**
 * Storage for per-patient wrapped data keys (spec 11.2). Destroying a patient's key makes every
 * field encrypted under it unrecoverable: crypto-shredding for REQ-009.
 *
 * The production implementation is a table in the clinical database; destroy() must physically
 * delete the row, not soft-delete it.
 */
export interface PatientKeyStore {
  /** Returns the wrapped key, `null` if none was ever created, or `'destroyed'` after shredding. */
  get(patientId: string): Promise<Uint8Array | null | 'destroyed'>;
  /** Stores a wrapped key if none exists. Returns whichever wrapped key is now stored. */
  putIfAbsent(patientId: string, wrapped: Uint8Array): Promise<Uint8Array>;
  destroy(patientId: string): Promise<void>;
}

/** Test and dev implementation. Not for any deployed environment. */
export class InMemoryPatientKeyStore implements PatientKeyStore {
  readonly #keys = new Map<string, Uint8Array>();
  readonly #destroyed = new Set<string>();

  get(patientId: string): Promise<Uint8Array | null | 'destroyed'> {
    if (this.#destroyed.has(patientId)) return Promise.resolve('destroyed');
    return Promise.resolve(this.#keys.get(patientId) ?? null);
  }

  putIfAbsent(patientId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    if (this.#destroyed.has(patientId)) {
      return Promise.reject(new Error('Cannot create a key for a shredded patient'));
    }
    const existing = this.#keys.get(patientId);
    if (existing) return Promise.resolve(existing);
    this.#keys.set(patientId, wrapped);
    return Promise.resolve(wrapped);
  }

  destroy(patientId: string): Promise<void> {
    this.#keys.delete(patientId);
    this.#destroyed.add(patientId);
    return Promise.resolve();
  }
}
