import { MemoryQueueStorage, type QueueStorage, type StoredEntry } from './queue.ts';

/**
 * IndexedDB storage for the offline queue (spec 14). The CryptoKey is stored by structured clone,
 * which keeps it non-extractable. Covered by the browser tests (e2e), like the components: there
 * is no IndexedDB in the unit-test runtime.
 */
const DB = 'endo-offline';
const KEYS = 'keys';
const ENTRIES = 'entries';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(KEYS);
      req.result.createObjectStore(ENTRIES, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('indexeddb'));
    };
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result as T);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('indexeddb'));
        };
      }),
  );
}

export class IdbQueueStorage implements QueueStorage {
  getKey() {
    return run<CryptoKey | undefined>(KEYS, 'readonly', (s) => s.get('queue')).then(
      (k) => k ?? null,
    );
  }
  putKey(key: CryptoKey): Promise<void> {
    return run<undefined>(KEYS, 'readwrite', (s) => s.put(key, 'queue'));
  }
  list() {
    return run<StoredEntry[]>(ENTRIES, 'readonly', (s) => s.getAll());
  }
  put(entry: StoredEntry): Promise<void> {
    return run<undefined>(ENTRIES, 'readwrite', (s) => s.put(entry));
  }
  delete(id: string): Promise<void> {
    return run<undefined>(ENTRIES, 'readwrite', (s) => s.delete(id));
  }
  async clear(): Promise<void> {
    await run<undefined>(ENTRIES, 'readwrite', (s) => s.clear());
    await run<undefined>(KEYS, 'readwrite', (s) => s.clear());
  }
}

/** IndexedDB where available; memory otherwise (private browsing on some browsers). */
export function queueStorage(): QueueStorage {
  return typeof indexedDB === 'undefined' ? new MemoryQueueStorage() : new IdbQueueStorage();
}
