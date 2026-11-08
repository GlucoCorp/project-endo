import type { Kysely } from 'kysely';
import type { ClinicalDatabase } from './schema.ts';

/** After this many failed attempts an event is set aside (and alerted) instead of retried. */
export const OUTBOX_MAX_ATTEMPTS = 5;

export interface RelayResult {
  readonly published: number;
  readonly failed: number;
}

/**
 * Relays queued audit events to the audit store (spec 2.6). Must run with the relay role
 * (endo_clinical_relay); the API role can only add events.
 *
 * - Each event is published in its own transaction and locked, so concurrent relays never take
 *   the same one. Delivery is at least once and unordered: a crash after the audit write but
 *   before the commit writes it again (same request_id, recognisable). Each event keeps its
 *   original time, which `publish` receives.
 * - A failed event has its attempt counted with a safe error code and is skipped for the rest of
 *   this run; after OUTBOX_MAX_ATTEMPTS it is set aside, so one bad event cannot block the rest.
 */
export async function relayAuditOutbox(
  db: Kysely<ClinicalDatabase>,
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
      } catch {
        return { failed: row.id };
      }
      await trx
        .updateTable('audit_outbox')
        .set({ published_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return 'published' as const;
    });
    if (outcome === 'empty') break;
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
  return { published, failed: failedIds.length };
}
