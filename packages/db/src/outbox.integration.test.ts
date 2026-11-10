import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Kysely } from 'kysely';
import {
  OUTBOX_MAX_ATTEMPTS,
  createDb,
  relayAuditOutbox,
  testDatabaseUrl,
  testSchemaPool,
  type AuditOutboxDatabase,
} from './index.ts';

const url = testDatabaseUrl();

/**
 * The shared relay against a bare outbox table. Each store's own tests cover its roles and
 * immutability triggers; this covers the relay's behaviour once, for every store.
 */
describe.skipIf(!url)(
  'spec 2.6 audit outbox relay (shared by clinical and identity stores)',
  () => {
    let pool: pg.Pool;
    let db: Kysely<AuditOutboxDatabase>;

    beforeAll(async () => {
      ({ pool } = await testSchemaPool(url!, 'outbox'));
      await pool.query(`CREATE TABLE audit_outbox (
      id uuid PRIMARY KEY,
      seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      event jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      attempts smallint NOT NULL DEFAULT 0,
      last_error text)`);
      db = createDb<AuditOutboxDatabase>(pool);
    });

    afterAll(async () => {
      await db.destroy();
    });

    const queue = async (...kinds: string[]) => {
      const ids = kinds.map(() => randomUUID());
      for (const [i, kind] of kinds.entries())
        await pool.query('INSERT INTO audit_outbox (id, event) VALUES ($1, $2)', [
          ids[i],
          JSON.stringify({ id: ids[i], kind }),
        ]);
      return ids;
    };

    it('publishes in order with each event time, once', async () => {
      await queue('a', 'b');
      const seen: [unknown, Date][] = [];
      const r = await relayAuditOutbox(db, (event, at) => {
        seen.push([event, at]);
        return Promise.resolve();
      });
      expect(r).toEqual({ published: 2, failed: 0 });
      expect(seen.map(([e]) => (e as { kind: string }).kind)).toEqual(['a', 'b']);
      expect(seen.every(([, at]) => at instanceof Date)).toBe(true);
      expect(await relayAuditOutbox(db, () => Promise.resolve())).toEqual({
        published: 0,
        failed: 0,
      });
    });

    it('counts failures with a safe code, skips the event for the run, then sets it aside', async () => {
      const [bad] = await queue('bad', 'good');
      const failBad = (event: unknown) =>
        (event as { kind: string }).kind === 'bad'
          ? Promise.reject(new Error('audit store down'))
          : Promise.resolve();
      expect(await relayAuditOutbox(db, failBad)).toEqual({ published: 1, failed: 1 });
      for (let i = 1; i < OUTBOX_MAX_ATTEMPTS + 2; i++) await relayAuditOutbox(db, failBad);
      const row = await pool.query<{ attempts: number; last_error: string; published_at: Date }>(
        'SELECT attempts, last_error, published_at FROM audit_outbox WHERE id = $1',
        [bad],
      );
      expect(row.rows[0]).toEqual({
        attempts: OUTBOX_MAX_ATTEMPTS,
        last_error: 'audit.publish_failed',
        published_at: null,
      });
    });

    it('stops at the batch limit', async () => {
      await queue('x', 'y', 'z');
      expect(await relayAuditOutbox(db, () => Promise.resolve(), 2)).toEqual({
        published: 2,
        failed: 0,
      });
      expect((await relayAuditOutbox(db, () => Promise.resolve())).published).toBe(1);
    });
  },
);
