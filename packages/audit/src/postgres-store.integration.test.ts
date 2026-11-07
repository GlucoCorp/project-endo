import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createDb, runMigrations, testDatabaseUrl, testSchemaPool } from '@endo/db';
import {
  AUDIT_MIGRATIONS_DIR,
  AuditWriter,
  GENESIS_HASH,
  PostgresAuditStore,
  verifyChain,
  type AuditDatabase,
  type AuditEventInputType,
} from './index.ts';

const url = testDatabaseUrl();

const input = (o: Partial<AuditEventInputType> = {}): AuditEventInputType => ({
  actor: { id: '01900000-0000-7000-8000-000000000001', role: 'clinician' },
  action: 'patient_data.read',
  resource: { type: 'treatment_episode', id: '01900000-0000-7000-8000-0000000000aa' },
  org_id: '01900000-0000-7000-8000-0000000000bb',
  purpose_of_use: 'treatment',
  outcome: 'success',
  reason: null,
  request_id: '01900000-0000-7000-8000-00000000000f',
  ...o,
});

describe.skipIf(!url)('RISK-R01 PostgresAuditStore (spec 2.6, 12.9)', () => {
  let schema: string;
  let pool: Awaited<ReturnType<typeof testSchemaPool>>['pool'];
  let db: Kysely<AuditDatabase>;

  /** Run raw SQL as the table owner, bypassing the app, to prove the database itself refuses. */
  const raw = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  beforeAll(async () => {
    ({ pool, schema } = await testSchemaPool(url!, 'audit'));
    await runMigrations(pool, AUDIT_MIGRATIONS_DIR);
    db = createDb<AuditDatabase>(pool);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('writes a verifiable chain that survives the round trip', async () => {
    const writer = new AuditWriter(new PostgresAuditStore(db));
    for (let i = 0; i < 5; i++) await writer.write(input());
    const events = await new PostgresAuditStore(db).readRange(1, 100);
    expect(events).toHaveLength(5);
    expect(events[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(verifyChain(events)).toMatchObject({ ok: true, count: 5 });
  });

  it('keeps one valid chain when several processes write at once', async () => {
    // Separate writers (no shared in-process queue) behave like separate service instances.
    const writers = Array.from({ length: 4 }, () => new AuditWriter(new PostgresAuditStore(db)));
    await Promise.all(writers.flatMap((w) => [w.write(input()), w.write(input())]));
    const events = await new PostgresAuditStore(db).readRange(1, 1000);
    expect(verifyChain(events).ok).toBe(true);
  });

  it.each([
    ['UPDATE', 'UPDATE audit_event SET outcome = $1 WHERE sequence = 1', ['denied']],
    ['DELETE', 'DELETE FROM audit_event WHERE sequence = 1', []],
    ['TRUNCATE', 'TRUNCATE audit_event', []],
  ])('the database refuses %s even from the table owner', async (_op, sql, params) => {
    await expect(raw(sql, params)).rejects.toThrow(/append-only/);
  });

  it('refuses an insert that does not link to its predecessor', async () => {
    const store = new PostgresAuditStore(db);
    const head = (await store.head())!;
    await expect(
      raw(
        `INSERT INTO audit_event (sequence, id, occurred_at, prev_hash, hash, actor_id, actor_role,
           action, resource_type, resource_id, org_id, purpose_of_use, outcome, reason, request_id)
         VALUES ($1, gen_random_uuid(), now(), $2, $3, NULL, 'system', 'x', 'y', NULL, NULL,
           'operations', 'success', NULL, gen_random_uuid())`,
        [head.sequence + 1, 'f'.repeat(64), 'e'.repeat(64)],
      ),
    ).rejects.toThrow(/prev_hash does not match/);
  });

  it('refuses free text even if application validation were bypassed (RISK-I02)', async () => {
    const store = new PostgresAuditStore(db);
    const head = (await store.head())!;
    await expect(
      raw(
        `INSERT INTO audit_event (sequence, id, occurred_at, prev_hash, hash, actor_role, action,
           resource_type, purpose_of_use, outcome, reason, request_id)
         VALUES ($1, gen_random_uuid(), now(), $2, $3, 'system', 'patient said pain 9', 'y',
           'operations', 'success', NULL, gen_random_uuid())`,
        [head.sequence + 1, head.hash, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it('the application role can only read and append', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE endo_audit_app');
      await client.query(`SET LOCAL search_path = ${schema}`);
      const rows = await client.query('SELECT count(*)::int AS n FROM audit_event');
      expect((rows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(0);
      await client.query('SAVEPOINT r');
      await expect(client.query('TRUNCATE audit_event')).rejects.toThrow(
        /permission denied|append-only/,
      );
      await client.query('ROLLBACK TO SAVEPOINT r');
      await client.query('SAVEPOINT s');
      await expect(client.query('UPDATE audit_event SET outcome = outcome')).rejects.toThrow(
        /permission denied/,
      );
      await client.query('ROLLBACK TO SAVEPOINT s');
      await expect(client.query('DELETE FROM audit_event')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
