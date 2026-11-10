import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditEvent } from './schema.ts';
import { AuditSequenceConflictError, type AuditStore } from './writer.ts';

/** Table shape for Kysely. Matches migrations/0001_audit_event.sql. */
export interface AuditDatabase {
  audit_event: {
    sequence: string; // int8 comes back from pg as a string
    id: string;
    occurred_at: Date;
    prev_hash: string;
    hash: string;
    actor_id: string | null;
    actor_role: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    org_id: string | null;
    purpose_of_use: string;
    outcome: string;
    reason: string | null;
    request_id: string;
  };
}

type Row = AuditDatabase['audit_event'];

function toEvent(r: Row): AuditEvent {
  const sequence = Number(r.sequence);
  if (!Number.isSafeInteger(sequence)) throw new Error('Audit sequence out of range');
  return {
    id: r.id,
    sequence,
    occurred_at: r.occurred_at.toISOString(),
    prev_hash: r.prev_hash,
    hash: r.hash,
    actor: { id: r.actor_id, role: r.actor_role as AuditEvent['actor']['role'] },
    action: r.action,
    resource: { type: r.resource_type, id: r.resource_id },
    org_id: r.org_id,
    purpose_of_use: r.purpose_of_use as AuditEvent['purpose_of_use'],
    outcome: r.outcome as AuditEvent['outcome'],
    reason: r.reason,
    request_id: r.request_id,
  };
}

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Durable audit store on PostgreSQL (spec 11.1 audit store; ADR-0008, ADR-0013). The database
 * enforces append-only, the event shape and chain linkage; this class maps rows and errors.
 */
export class PostgresAuditStore implements AuditStore {
  readonly #db: Kysely<AuditDatabase>;

  constructor(db: Kysely<AuditDatabase>) {
    this.#db = db;
  }

  head(): Promise<AuditEvent | null> {
    return readHead(this.#db);
  }

  /**
   * One transaction holding a transaction-scoped advisory lock, so writers in every process queue
   * here: the head read inside the lock is still the head when the event is inserted.
   */
  async appendNext(build: (head: AuditEvent | null) => AuditEvent): Promise<AuditEvent> {
    return this.#db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('endo-audit-append', 0))`.execute(
        trx,
      );
      const event = build(await readHead(trx));
      await insert(trx, event);
      return event;
    });
  }

  async append(event: AuditEvent): Promise<void> {
    await insert(this.#db, event);
  }

  async readRange(fromSequence: number, limit: number): Promise<readonly AuditEvent[]> {
    const rows = await this.#db
      .selectFrom('audit_event')
      .selectAll()
      .where('sequence', '>=', String(fromSequence))
      .orderBy('sequence', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toEvent);
  }
}

type Db = Kysely<AuditDatabase> | Transaction<AuditDatabase>;

async function readHead(db: Db): Promise<AuditEvent | null> {
  const row = await db
    .selectFrom('audit_event')
    .selectAll()
    .orderBy('sequence', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toEvent(row) : null;
}

async function insert(db: Db, event: AuditEvent): Promise<void> {
  try {
    await db
      .insertInto('audit_event')
      .values({
        sequence: String(event.sequence),
        id: event.id,
        occurred_at: new Date(event.occurred_at),
        prev_hash: event.prev_hash,
        hash: event.hash,
        actor_id: event.actor.id,
        actor_role: event.actor.role,
        action: event.action,
        resource_type: event.resource.type,
        resource_id: event.resource.id,
        org_id: event.org_id,
        purpose_of_use: event.purpose_of_use,
        outcome: event.outcome,
        reason: event.reason,
        request_id: event.request_id,
      })
      .execute();
  } catch (error) {
    if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      throw new AuditSequenceConflictError();
    }
    throw error;
  }
}
