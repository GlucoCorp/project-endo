import type { Kysely } from 'kysely';
import type { ClinicalDatabase } from './schema.ts';

/**
 * Relays queued audit events to the audit store, oldest first (spec 2.6). Each event is published
 * in its own transaction and locked, so concurrent relays never take the same one. Delivery is at
 * least once: if the process stops after the audit write but before the commit, the event is
 * written again on the next run (same request_id, so a duplicate is recognisable).
 */
export async function relayAuditOutbox(
  db: Kysely<ClinicalDatabase>,
  publish: (event: unknown) => Promise<void>,
  max = 50,
): Promise<number> {
  let published = 0;
  while (published < max) {
    const done = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('audit_outbox')
        .select(['id', 'event'])
        .where('published_at', 'is', null)
        .orderBy('seq')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return false;
      await publish(row.event);
      await trx
        .updateTable('audit_outbox')
        .set({ published_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return true;
    });
    if (!done) break;
    published += 1;
  }
  return published;
}
