import type { SendResult } from './api.ts';

/**
 * Offline check-ins (spec 14, REQ-003; Section 24 item 29). What she could not send is kept on
 * this phone, encrypted with an AES-GCM key that WebCrypto creates non-extractable: the page can
 * use it but never read it out. The key and the entries live in IndexedDB for the life of her
 * session, so a reload does not strand them, and are destroyed on sign-out, quick exit or when
 * the session is gone. Each entry has a fresh 96-bit IV and is bound to its own id and the
 * format version as associated data, so entries cannot be swapped or replayed under another id.
 *
 * Red flags are always sent before check-ins.
 */
export interface QueueItem {
  readonly kind: 'red_flags' | 'checkin';
  readonly url: string;
  readonly key: string;
  readonly body: unknown;
  readonly createdAt: string;
}

export interface StoredEntry {
  readonly id: string;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
  /** Priority without decrypting: red flags first. */
  readonly kind: QueueItem['kind'];
}

/** Persistence for the key and the encrypted entries (IndexedDB in the app, memory in tests). */
export interface QueueStorage {
  getKey(): Promise<CryptoKey | null>;
  putKey(key: CryptoKey): Promise<void>;
  list(): Promise<StoredEntry[]>;
  put(entry: StoredEntry): Promise<void>;
  delete(id: string): Promise<void>;
  /** Deletes the key and every entry. */
  clear(): Promise<void>;
}

const VERSION = 'endo-queue-v1';
const aad = (id: string) => new TextEncoder().encode(`${VERSION}:${id}`);

export class OfflineQueue {
  readonly #storage: QueueStorage;
  readonly #crypto: Crypto;
  #draining: Promise<DrainResult> | null = null;

  constructor(storage: QueueStorage, crypto: Crypto = globalThis.crypto) {
    this.#storage = storage;
    this.#crypto = crypto;
  }

  async #key(): Promise<CryptoKey> {
    const existing = await this.#storage.getKey();
    if (existing) return existing;
    const key = await this.#crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await this.#storage.putKey(key);
    return key;
  }

  async add(item: QueueItem): Promise<void> {
    const key = await this.#key();
    const id = this.#crypto.randomUUID();
    const iv = this.#crypto.getRandomValues(new Uint8Array(12));
    const data = await this.#crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(id) },
      key,
      new TextEncoder().encode(JSON.stringify(item)),
    );
    await this.#storage.put({ id, iv, data, kind: item.kind });
  }

  async size(): Promise<number> {
    return (await this.#storage.list()).length;
  }

  /**
   * Sends what is queued, red flags first, one at a time; only one drain runs at once. Sent or
   * refused-for-good entries are deleted; on offline or signed-out it stops and keeps the rest.
   * An entry that cannot be decrypted (another session's key) is deleted unread.
   */
  drain(sendItem: (item: QueueItem) => Promise<SendResult>): Promise<DrainResult> {
    this.#draining ??= this.#drain(sendItem).finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }

  async #drain(sendItem: (item: QueueItem) => Promise<SendResult>): Promise<DrainResult> {
    const result = {
      sent: 0,
      refused: 0,
      remaining: 0,
      stopped: null as SendResult['kind'] | null,
    };
    const entries = (await this.#storage.list()).sort(
      (a, b) => Number(b.kind === 'red_flags') - Number(a.kind === 'red_flags'),
    );
    const key = await this.#storage.getKey();
    for (const [i, entry] of entries.entries()) {
      let item: QueueItem;
      try {
        if (!key) throw new Error('no key');
        const plain = await this.#crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: entry.iv, additionalData: aad(entry.id) },
          key,
          entry.data,
        );
        item = JSON.parse(new TextDecoder().decode(plain)) as QueueItem;
      } catch {
        await this.#storage.delete(entry.id);
        continue;
      }
      const r = await sendItem(item);
      if (r.kind === 'ok' || r.kind === 'refused') {
        await this.#storage.delete(entry.id);
        if (r.kind === 'ok') result.sent++;
        else result.refused++;
        continue;
      }
      result.stopped = r.kind;
      result.remaining = entries.length - i;
      break;
    }
    return result;
  }

  /** Sign-out, quick exit or a session that is gone: the key and every entry are destroyed. */
  clear(): Promise<void> {
    return this.#storage.clear();
  }
}

export interface DrainResult {
  readonly sent: number;
  readonly refused: number;
  readonly remaining: number;
  readonly stopped: SendResult['kind'] | null;
}

/** For tests and for browsers without IndexedDB (then nothing survives a reload). */
export class MemoryQueueStorage implements QueueStorage {
  #key: CryptoKey | null = null;
  readonly #entries = new Map<string, StoredEntry>();

  getKey() {
    return Promise.resolve(this.#key);
  }
  putKey(key: CryptoKey) {
    this.#key = key;
    return Promise.resolve();
  }
  list() {
    return Promise.resolve([...this.#entries.values()]);
  }
  put(entry: StoredEntry) {
    this.#entries.set(entry.id, entry);
    return Promise.resolve();
  }
  delete(id: string) {
    this.#entries.delete(id);
    return Promise.resolve();
  }
  clear() {
    this.#key = null;
    this.#entries.clear();
    return Promise.resolve();
  }
}
