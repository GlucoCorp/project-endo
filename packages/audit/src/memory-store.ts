import type { AuditEvent } from './schema.ts';
import { AuditSequenceConflictError, type AuditStore } from './writer.ts';

/** Dev and test store. Enforces the same append-only, contiguous-sequence contract as production. */
export class InMemoryAuditStore implements AuditStore {
  readonly #events: AuditEvent[] = [];

  head(): Promise<AuditEvent | null> {
    return Promise.resolve(this.#events.at(-1) ?? null);
  }

  append(event: AuditEvent): Promise<void> {
    const expected = (this.#events.at(-1)?.sequence ?? 0) + 1;
    if (event.sequence !== expected) {
      return Promise.reject(new AuditSequenceConflictError());
    }
    this.#events.push(Object.freeze(structuredClone(event)));
    return Promise.resolve();
  }

  readRange(fromSequence: number, limit: number): Promise<readonly AuditEvent[]> {
    return Promise.resolve(this.#events.filter((e) => e.sequence >= fromSequence).slice(0, limit));
  }
}
