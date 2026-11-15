import type { AuditEvent } from './schema.ts';
import {
  AuditSequenceConflictError,
  type AuditReader,
  type AuditStore,
  type ResourceRef,
} from './writer.ts';

/** Dev and test store. Enforces the same append-only, contiguous-sequence contract as production. */
export class InMemoryAuditStore implements AuditStore, AuditReader {
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

  async appendNext(build: (head: AuditEvent | null) => AuditEvent): Promise<AuditEvent> {
    // Single-threaded: nothing can append between reading the head and appending.
    const event = build(this.#events.at(-1) ?? null);
    await this.append(event);
    return event;
  }

  readRange(fromSequence: number, limit: number): Promise<readonly AuditEvent[]> {
    return Promise.resolve(this.#events.filter((e) => e.sequence >= fromSequence).slice(0, limit));
  }

  forResources(refs: readonly ResourceRef[], limit: number): Promise<readonly AuditEvent[]> {
    const keys = new Set(refs.map((r) => `${r.type}:${r.id}`));
    return Promise.resolve(
      this.#events
        .filter((e) => e.resource.id !== null && keys.has(`${e.resource.type}:${e.resource.id}`))
        .reverse()
        .slice(0, limit),
    );
  }
}
