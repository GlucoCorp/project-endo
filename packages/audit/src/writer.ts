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
 * `head.sequence + 1`.
 */
export interface AuditStore {
  head(): Promise<AuditEvent | null>;
  append(event: AuditEvent): Promise<void>;
  /**
   * Reads the head and appends the event `build` makes from it, exclusively: no other writer, in
   * any process, appends in between. Concurrent service instances then queue instead of racing
   * for the next sequence (which could starve a writer under load).
   */
  appendNext(build: (head: AuditEvent | null) => AuditEvent): Promise<AuditEvent>;
  readRange(fromSequence: number, limit: number): Promise<readonly AuditEvent[]>;
}

/** A resource an access log asks about (spec 13.3): its type and opaque id. */
export interface ResourceRef {
  readonly type: string;
  readonly id: string;
}

/**
 * Reads the events about given resources, newest first (spec 13.3 access log). Separate from
 * AuditStore: only the access-log route needs it.
 */
export interface AuditReader {
  /** At most `limit` (1 to 500); `beforeSequence` pages back through older events. */
  forResources(
    refs: readonly ResourceRef[],
    limit: number,
    beforeSequence?: number,
  ): Promise<readonly AuditEvent[]>;
}

/**
 * Thrown by a store when another writer appended the same sequence first. The writer re-reads
 * the head and retries; it never overwrites.
 */
export class AuditSequenceConflictError extends Error {
  constructor() {
    super('Audit sequence conflict');
    this.name = 'AuditSequenceConflictError';
  }
}

/**
 * Attempts per event. appendNext is exclusive, so a conflict means a writer outside that lock
 * (for example an older version during a rolling deploy); retrying on the new head is safe.
 */
const MAX_APPEND_ATTEMPTS = 5;

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

  /**
   * Serialised within this process, and across processes by the store's exclusive appendNext. If
   * the store still reports AuditSequenceConflictError, the event is rebuilt on the new head and
   * retried.
   *
   * `occurredAt`: when the action really happened, for events relayed later from an outbox
   * (spec 2.6). Defaults to now. It may not lie in the future.
   */
  async write(input: AuditEventInputType, occurredAt?: Date): Promise<AuditEvent> {
    const parsed = AuditEventInput.parse(input);
    const run = this.#tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        const now = this.#clock();
        if (occurredAt && occurredAt.getTime() > now.getTime()) {
          throw new RangeError('occurredAt is in the future');
        }
        const when = occurredAt ?? now;
        try {
          return await this.#store.appendNext((head) => {
            const base = {
              ...parsed,
              id: uuidv7(now.getTime()),
              sequence: head ? head.sequence + 1 : 1,
              occurred_at: when.toISOString(),
              prev_hash: head ? head.hash : GENESIS_HASH,
            };
            return { ...base, hash: hashEvent(base) };
          });
        } catch (error) {
          if (!(error instanceof AuditSequenceConflictError) || attempt >= MAX_APPEND_ATTEMPTS) {
            throw error;
          }
        }
      }
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
