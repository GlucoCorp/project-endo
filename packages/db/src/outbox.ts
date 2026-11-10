import { sql, type Generated, type Kysely } from 'kysely';

/**
 * The audit outbox table each store keeps (clinical, identity): audit events written in the same
 * transaction as the change they describe, then relayed to the audit store (spec 2.6). Each
 * store's migrations make rows immutable and publishable once.
 */
export interface AuditOutboxTable {
  id: string;
  seq: Generated<string>;
  event: unknown;
  created_at: Generated<Date>;
  published_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
}
export interface AuditOutboxDatabase {
  audit_outbox: AuditOutboxTable;
}

/** After this many failed attempts an event is set aside (and alerted) instead of retried. */
export const OUTBOX_MAX_ATTEMPTS = 5;

export interface RelayResult {
  readonly published: number;
  /** Events rejected as bad (PermanentPublishError) in this run; each had an attempt counted. */
  readonly failed: number;
  /** The run stopped at a failure that was not the event's fault (audit store unreachable). */
  readonly interrupted: boolean;
}

/**
 * Thrown by `publish` when the event itself can never be published (it fails the audit schema).
 * Only these count as failed attempts. Any other failure is treated as an outage: nothing is
 * counted and the run stops, so a down audit store never uses up events' attempts.
 */
export class PermanentPublishError extends Error {
  constructor() {
    super('audit.event_invalid');
    this.name = 'PermanentPublishError';
  }
}

/**
 * Relays queued audit events to the audit store (spec 2.6). Must run with the store's relay
 * role (endo_clinical_relay, endo_identity_relay); the service role can only add events.
 *
 * - Each event is published in its own transaction and locked, so concurrent relays never take
 *   the same one. Delivery is at least once and unordered: a crash after the audit write but
 *   before the commit writes it again (same request_id, recognisable). Each event keeps its
 *   original time, which `publish` receives.
 * - An event rejected as bad (PermanentPublishError) has its attempt counted with a safe error
 *   code and is skipped for the rest of this run; after OUTBOX_MAX_ATTEMPTS it is set aside, so
 *   one bad event cannot block the rest.
 * - Any other failure means the audit store is unavailable: no attempt is counted and the run
 *   stops (`interrupted`). The next run starts again from the oldest event, so an outage of any
 *   length loses nothing. If the store keeps refusing one event for another reason, delivery
 *   stalls behind it and `outboxHealth` shows the growing backlog: stalling with an alert is
 *   preferred to skipping audit events silently.
 */
export async function relayAuditOutbox(
  db: Kysely<AuditOutboxDatabase>,
  publish: (event: unknown, occurredAt: Date) => Promise<void>,
  max = 50,
): Promise<RelayResult> {
  let published = 0;
  const failedIds: string[] = [];
  while (published + failedIds.length < max) {
    const outcome = await db.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom('audit_outbox')
        .select(['id', 'event', 'created_at'])
        .where('published_at', 'is', null)
        .where('attempts', '<', OUTBOX_MAX_ATTEMPTS);
      if (failedIds.length > 0) query = query.where('id', 'not in', failedIds);
      const row = await query.orderBy('seq').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!row) return 'empty' as const;
      try {
        await publish(row.event, row.created_at);
      } catch (error) {
        return error instanceof PermanentPublishError
          ? { failed: row.id }
          : ('interrupted' as const);
      }
      await trx
        .updateTable('audit_outbox')
        .set({ published_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return 'published' as const;
    });
    if (outcome === 'empty') break;
    if (outcome === 'interrupted')
      return { published, failed: failedIds.length, interrupted: true };
    if (outcome === 'published') {
      published += 1;
      continue;
    }
    failedIds.push(outcome.failed);
    await db
      .updateTable('audit_outbox')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: 'audit.publish_failed' }))
      .where('id', '=', outcome.failed)
      .where('published_at', 'is', null)
      .execute();
  }
  return { published, failed: failedIds.length, interrupted: false };
}

export interface OutboxHealth {
  /** Waiting to be published (not set aside). */
  readonly pending: number;
  /** Set aside after OUTBOX_MAX_ATTEMPTS: needs a person to look. */
  readonly setAside: number;
  /** Age of the oldest pending event in seconds, by the database clock; null when none. */
  readonly oldestPendingSeconds: number | null;
}

/** Counts only, for alerting (spec 2.6): never event contents. Run with the relay role. */
export async function outboxHealth(db: Kysely<AuditOutboxDatabase>): Promise<OutboxHealth> {
  const row = await db
    .selectFrom('audit_outbox')
    .select([
      sql<string>`count(*) FILTER (WHERE attempts < ${OUTBOX_MAX_ATTEMPTS})`.as('pending'),
      sql<string>`count(*) FILTER (WHERE attempts >= ${OUTBOX_MAX_ATTEMPTS})`.as('set_aside'),
      sql<
        number | null
      >`extract(epoch FROM now() - min(created_at) FILTER (WHERE attempts < ${OUTBOX_MAX_ATTEMPTS}))::float8`.as(
        'oldest',
      ),
    ])
    .where('published_at', 'is', null)
    .executeTakeFirstOrThrow();
  return {
    pending: Number(row.pending),
    setAside: Number(row.set_aside),
    oldestPendingSeconds: row.oldest === null ? null : Math.floor(row.oldest),
  };
}

/** A backlog older than this, or anything set aside, is alert-worthy. */
export const OUTBOX_STALE_SECONDS = 60;

/** One alert line with counts only, or null when the outbox is healthy. */
export function outboxAlert(source: string, h: OutboxHealth): string | null {
  if (h.setAside === 0 && (h.oldestPendingSeconds ?? 0) < OUTBOX_STALE_SECONDS) return null;
  return `${source} audit outbox: ${String(h.pending)} pending (oldest ${String(h.oldestPendingSeconds ?? 0)} s), ${String(h.setAside)} set aside\n`;
}
