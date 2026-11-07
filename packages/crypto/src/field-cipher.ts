import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyManager, KeyRef } from './key-manager.ts';
import type { PatientKeyStore } from './patient-key-store.ts';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * What a ciphertext is bound to. Used as AES-GCM associated data so a ciphertext copied into
 * another row, column or patient fails to decrypt (RISK-T01, RISK-I01).
 */
export interface FieldContext {
  readonly patientId: string;
  /** Logical field name, e.g. `goal.text`, `review_decision.note`. */
  readonly field: string;
  /** Opaque ID of the row holding the field. */
  readonly recordId: string;
}

export class KeyDestroyedError extends Error {
  constructor() {
    super('Data key has been destroyed (crypto-shredded)');
    this.name = 'KeyDestroyedError';
  }
}

/** Deliberately vague: never says which part failed, and never includes data. */
export class DecryptionError extends Error {
  constructor() {
    super('Field could not be decrypted');
    this.name = 'DecryptionError';
  }
}

function aad(ctx: FieldContext): Buffer {
  // JSON array gives an unambiguous encoding (no delimiter injection between parts).
  return Buffer.from(JSON.stringify([VERSION, ctx.patientId, ctx.field, ctx.recordId]), 'utf8');
}

/**
 * Field-level envelope encryption with per-patient data keys (spec 11.2).
 *
 * Format: `v1.<iv>.<ciphertext>.<tag>` (base64url parts). AES-256-GCM from node:crypto only.
 */
export class FieldCipher {
  readonly #kms: KeyManager;
  readonly #store: PatientKeyStore;
  readonly #keyRef: KeyRef;

  constructor(kms: KeyManager, store: PatientKeyStore, keyRef: KeyRef = 'kms/clinical') {
    this.#kms = kms;
    this.#store = store;
    this.#keyRef = keyRef;
  }

  async #dataKey(patientId: string, create: boolean): Promise<Uint8Array> {
    let wrapped = await this.#store.get(patientId);
    if (wrapped === 'destroyed') throw new KeyDestroyedError();
    if (wrapped === null) {
      if (!create) throw new DecryptionError();
      const fresh = await this.#kms.generateDataKey(this.#keyRef);
      fresh.plaintext.fill(0);
      wrapped = await this.#store.putIfAbsent(patientId, fresh.wrapped);
    }
    return this.#kms.unwrapDataKey(this.#keyRef, wrapped);
  }

  async encrypt(plaintext: string, ctx: FieldContext): Promise<string> {
    const key = await this.#dataKey(ctx.patientId, true);
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(ctx));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, body, tag]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    } finally {
      key.fill(0);
    }
  }

  async decrypt(envelope: string, ctx: FieldContext): Promise<string> {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptionError();
    const [, ivB64, bodyB64, tagB64] = parts as [string, string, string, string];
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError();

    const key = await this.#dataKey(ctx.patientId, false);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad(ctx));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(bodyB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new DecryptionError();
    } finally {
      key.fill(0);
    }
  }

  /** Crypto-shred: after this, every field for the patient is unrecoverable (REQ-009). */
  async shredPatient(patientId: string): Promise<void> {
    await this.#store.destroy(patientId);
  }
}
