import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Kysely } from 'kysely';
import {
  OUTBOX_MAX_ATTEMPTS,
  PermanentPublishError,
  createDb,
  outboxAlert,
  outboxHealth,
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
      expect(r).toEqual({ published: 2, failed: 0, interrupted: false });
      expect(seen.map(([e]) => (e as { kind: string }).kind)).toEqual(['a', 'b']);
      expect(seen.every(([, at]) => at instanceof Date)).toBe(true);
      expect(await relayAuditOutbox(db, () => Promise.resolve())).toEqual({
        published: 0,
        failed: 0,
        interrupted: false,
      });
    });

    it('counts a bad event with a safe code, skips it for the run, then sets it aside', async () => {
      const [bad] = await queue('bad', 'good');
      const failBad = (event: unknown) =>
        (event as { kind: string }).kind === 'bad'
          ? Promise.reject(new PermanentPublishError())
          : Promise.resolve();
      expect(await relayAuditOutbox(db, failBad)).toEqual({
        published: 1,
        failed: 1,
        interrupted: false,
      });
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

    const attemptsOf = async (ids: string[]) =>
      (
        await pool.query<{ attempts: number }>(
          'SELECT attempts FROM audit_outbox WHERE id = ANY($1) ORDER BY seq',
          [ids],
        )
      ).rows.map((r) => r.attempts);
    const drain = () => relayAuditOutbox(db, () => Promise.resolve(), 10_000);

    it('waits out an audit store outage of any length: nothing counted, nothing lost', async () => {
      await drain();
      const setAsideBefore = (await outboxHealth(db)).setAside;
      const ids = await queue('p', 'q');
      const down = () => Promise.reject(new Error('connect ECONNREFUSED'));
      // Far more runs than OUTBOX_MAX_ATTEMPTS: an outage never uses up attempts.
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS * 3; i++)
        expect(await relayAuditOutbox(db, down)).toEqual({
          published: 0,
          failed: 0,
          interrupted: true,
        });
      expect(await attemptsOf(ids)).toEqual([0, 0]);
      expect((await outboxHealth(db)).setAside).toBe(setAsideBefore);
      // Recovery: everything is published, in order.
      const seen: string[] = [];
      await relayAuditOutbox(db, (e) =>
        Promise.resolve(void seen.push((e as { kind: string }).kind)),
      );
      expect(seen).toEqual(['p', 'q']);
    });

    it('stops at an outage mid-run and resumes from the oldest unpublished event', async () => {
      await drain();
      await queue('m1', 'm2', 'm3');
      let calls = 0;
      const failSecond = () =>
        ++calls === 2 ? Promise.reject(new Error('timeout')) : Promise.resolve();
      expect(await relayAuditOutbox(db, failSecond)).toEqual({
        published: 1,
        failed: 0,
        interrupted: true,
      });
      const seen: string[] = [];
      await relayAuditOutbox(db, (e) =>
        Promise.resolve(void seen.push((e as { kind: string }).kind)),
      );
      expect(seen).toEqual(['m2', 'm3']);
    });

    it('reports backlog health in counts only, and alerts when it needs a person', async () => {
      await drain();
      expect(await outboxHealth(db)).toEqual({
        pending: 0,
        setAside: expect.any(Number) as number,
        oldestPendingSeconds: null,
      });
      const before = (await outboxHealth(db)).setAside;
      const [stale] = await queue('SYNTHETIC_PHI_MARKER-stale');
      await pool.query(
        "UPDATE audit_outbox SET created_at = now() - interval '5 minutes' WHERE id = $1",
        [stale],
      );
      const h = await outboxHealth(db);
      expect(h.pending).toBe(1);
      expect(h.oldestPendingSeconds).toBeGreaterThanOrEqual(299);
      const line = outboxAlert('test', h);
      expect(line).toMatch(/^test audit outbox: 1 pending \(oldest \d+ s\), \d+ set aside\n$/);
      expect(line).not.toContain('SYNTHETIC_PHI_MARKER');
      await drain();
      const healthy = await outboxHealth(db);
      expect(healthy.setAside).toBe(before);
      // Healthy only when nothing is set aside either.
      expect(outboxAlert('test', { ...healthy, setAside: 0 })).toBeNull();
      expect(outboxAlert('test', { ...healthy, setAside: 1 })).not.toBeNull();
    });

    it('stops at the batch limit', async () => {
      await queue('x', 'y', 'z');
      expect(await relayAuditOutbox(db, () => Promise.resolve(), 2)).toEqual({
        published: 2,
        failed: 0,
        interrupted: false,
      });
      expect((await relayAuditOutbox(db, () => Promise.resolve())).published).toBe(1);
    });
  },
);
