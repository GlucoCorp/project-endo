import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptionError } from './field-cipher.ts';
import type { KeyManager, KeyRef } from './key-manager.ts';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A value sealed under its own data key. Both parts are safe to store; neither alone reveals it. */
export interface SealedValue {
  /** The data key, wrapped by the KMS master key (base64url). */
  readonly wrappedKey: string;
  /** `v1.<iv>.<ciphertext>.<tag>`, AES-256-GCM, base64url parts. */
  readonly envelope: string;
}

/**
 * Envelope encryption with a fresh data key per value (spec 11.2), for short-lived secrets that
 * belong to no patient yet, such as an idempotent replay of an enrolment response (ADR-0017).
 * `context` is bound as associated data, so a sealed value moved to another record fails to open.
 */
export class EnvelopeSealer {
  readonly #kms: KeyManager;
  readonly #keyRef: KeyRef;

  constructor(kms: KeyManager, keyRef: KeyRef) {
    this.#kms = kms;
    this.#keyRef = keyRef;
  }

  async seal(plaintext: string, context: string): Promise<SealedValue> {
    const dataKey = await this.#kms.generateDataKey(this.#keyRef);
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const envelope = [VERSION, iv, body, cipher.getAuthTag()]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
      return { wrappedKey: Buffer.from(dataKey.wrapped).toString('base64url'), envelope };
    } finally {
      dataKey.plaintext.fill(0);
    }
  }

  async open(sealed: SealedValue, context: string): Promise<string> {
    const parts = sealed.envelope.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptionError();
    const [, ivB64, bodyB64, tagB64] = parts as [string, string, string, string];
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError();
    let key: Uint8Array;
    try {
      key = await this.#kms.unwrapDataKey(
        this.#keyRef,
        Buffer.from(sealed.wrappedKey, 'base64url'),
      );
    } catch {
      throw new DecryptionError();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, 'utf8'));
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
}
