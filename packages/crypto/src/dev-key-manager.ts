import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isDeployedEnvironment, type EnvironmentName } from '@endo/config';
import type { DataKey, KeyManager, KeyRef } from './key-manager.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Local stand-in for KMS. Holds one random, in-memory master key per KeyRef that is lost when the
 * process exits. Refuses to construct in staging or production (RISK-I01).
 *
 * Wrapping uses AES-256-GCM from node:crypto with the KeyRef as associated data, so a key wrapped
 * for one store cannot be unwrapped as another.
 */
export class DevKeyManager implements KeyManager {
  readonly #masters = new Map<KeyRef, Buffer>();

  constructor(env: EnvironmentName) {
    if (isDeployedEnvironment(env)) {
      throw new Error(`DevKeyManager is not allowed in ${env}; configure a real KMS.`);
    }
  }

  #master(keyRef: KeyRef): Buffer {
    let key = this.#masters.get(keyRef);
    if (!key) {
      key = randomBytes(KEY_BYTES);
      this.#masters.set(keyRef, key);
    }
    return key;
  }

  generateDataKey(keyRef: KeyRef): Promise<DataKey> {
    const plaintext = randomBytes(KEY_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#master(keyRef), iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(keyRef, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = Buffer.concat([iv, body, cipher.getAuthTag()]);
    return Promise.resolve({
      plaintext: new Uint8Array(plaintext),
      wrapped: new Uint8Array(wrapped),
    });
  }

  unwrapDataKey(keyRef: KeyRef, wrapped: Uint8Array): Promise<Uint8Array> {
    if (wrapped.length !== IV_BYTES + KEY_BYTES + TAG_BYTES) {
      return Promise.reject(new Error('Wrapped key has the wrong length'));
    }
    const buf = Buffer.from(wrapped);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#master(keyRef),
      buf.subarray(0, IV_BYTES),
      // Pin the tag length so a truncated tag can never be accepted (Semgrep gcm-no-tag-length).
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(keyRef, 'utf8'));
    decipher.setAuthTag(buf.subarray(IV_BYTES + KEY_BYTES));
    try {
      const plain = Buffer.concat([
        decipher.update(buf.subarray(IV_BYTES, IV_BYTES + KEY_BYTES)),
        decipher.final(),
      ]);
      return Promise.resolve(new Uint8Array(plain));
    } catch {
      return Promise.reject(new Error('Wrapped key failed authentication'));
    }
  }
}
