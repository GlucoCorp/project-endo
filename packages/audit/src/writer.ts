import { createHash, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '@endo/domain';
import {
  AuditEventInput,
  GENESIS_HASH,
  type AuditEvent,
  type AuditEventInputType,
} from './schema.ts';

/**
 * Append-only store. Implementations must reject updates and deletes (Postgres: no UPDATE/DELETE
 * grants for the app role, plus a trigger). `append` must fail if `event.sequence` is not exactly
 * `head.sequence + 1`, which serialises concurrent writers.
 */
export interface AuditStore {
  head(): Promise<AuditEvent | null>;
  append(event: AuditEvent): Promise<void>;
  readRange(fromSequence: number, limit: number): Promise<readonly AuditEvent[]>;
}

/**
 * Canonical hash input. The field order is fixed here, not taken from object key order, so the
 * hash is stable across runtimes and serialisers.
 */
function canonical(e: Omit<AuditEvent, 'hash'>): string {
  return JSON.stringify([
    e.id,
    e.sequence,
    e.occurred_at,
    e.prev_hash,
    e.actor.id,
    e.actor.role,
    e.action,
    e.resource.type,
    e.resource.id,
    e.org_id,
    e.purpose_of_use,
    e.outcome,
    e.reason,
    e.request_id,
  ]);
}

function sameHash(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hashEvent(e: Omit<AuditEvent, 'hash'>): string {
  return createHash('sha256').update(canonical(e), 'utf8').digest('hex');
}

/**
 * Writes hash-chained audit events (spec 12.9, RISK-R01). Validation failures throw: an event that
 * cannot be audited must not be silently dropped, and the caller must fail the request.
 */
export class AuditWriter {
  readonly #store: AuditStore;
  readonly #clock: () => Date;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(store: AuditStore, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#clock = clock;
  }

  /** Serialised within this process; the store's sequence check serialises across processes. */
  async write(input: AuditEventInputType): Promise<AuditEvent> {
    const parsed = AuditEventInput.parse(input);
    const run = this.#tail.then(async () => {
      const head = await this.#store.head();
      const now = this.#clock();
      const base = {
        ...parsed,
        id: uuidv7(now.getTime()),
        sequence: head ? head.sequence + 1 : 1,
        occurred_at: now.toISOString(),
        prev_hash: head ? head.hash : GENESIS_HASH,
      };
      const event: AuditEvent = { ...base, hash: hashEvent(base) };
      await this.#store.append(event);
      return event;
    });
    this.#tail = run.catch(() => undefined);
    return await run;
  }
}

export type ChainVerification =
  | { readonly ok: true; readonly count: number; readonly headHash: string }
  | {
      readonly ok: false;
      readonly brokenAtSequence: number;
      readonly reason: 'hash' | 'link' | 'sequence';
    };

/**
 * Verify a contiguous run of events. `previousHash` is the hash of the event before the first one
 * supplied (GENESIS_HASH when starting at sequence 1, or a published daily anchor).
 */
export function verifyChain(
  events: readonly AuditEvent[],
  previousHash: string = GENESIS_HASH,
): ChainVerification {
  let prev = previousHash;
  let expectedSeq = events[0]?.sequence ?? 1;
  for (const e of events) {
    if (e.sequence !== expectedSeq)
      return { ok: false, brokenAtSequence: e.sequence, reason: 'sequence' };
    if (e.prev_hash !== prev) return { ok: false, brokenAtSequence: e.sequence, reason: 'link' };
    const { hash, ...rest } = e;
    if (!sameHash(hashEvent(rest), hash))
      return { ok: false, brokenAtSequence: e.sequence, reason: 'hash' };
    prev = hash;
    expectedSeq += 1;
  }
  return { ok: true, count: events.length, headHash: prev };
}
