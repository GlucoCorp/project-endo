import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type pg from 'pg';
import {
  MigrationError,
  createDb,
  runMigrations,
  testDatabaseUrl,
  testSchemaPool,
} from './index.ts';

const url = testDatabaseUrl();
const pools: pg.Pool[] = [];
const dirs: string[] = [];

/** A fresh schema and migrations folder per test, so tests never share state. */
async function fixture(files: Record<string, string>) {
  const { pool } = await testSchemaPool(url!, 't');
  pools.push(pool);
  const dir = await mkdtemp(join(tmpdir(), 'endo-migrations-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { pool, dir };
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!url)('runMigrations (spec 18.3)', () => {
  it('applies migrations in order and is idempotent', async () => {
    const { pool, dir } = await fixture({
      '0002_add_col.sql': 'ALTER TABLE thing ADD COLUMN b int;',
      '0001_create.sql': 'CREATE TABLE thing (a int);',
    });
    expect(await runMigrations(pool, dir)).toEqual({
      applied: ['0001_create.sql', '0002_add_col.sql'],
      alreadyApplied: [],
    });
    expect(await runMigrations(pool, dir)).toEqual({
      applied: [],
      alreadyApplied: ['0001_create.sql', '0002_add_col.sql'],
    });
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'thing' AND table_schema = current_schema() ORDER BY 1",
    );
    expect(cols.rows.map((r: { column_name: string }) => r.column_name)).toEqual(['a', 'b']);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const { pool, dir } = await fixture({ '0001_create.sql': 'CREATE TABLE thing (a int);' });
    await runMigrations(pool, dir);
    await writeFile(join(dir, '0001_create.sql'), 'CREATE TABLE thing (a int, sneaky text);');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/has been modified/);
  });

  it('rolls back a failing migration completely', async () => {
    const { pool, dir } = await fixture({
      '0001_ok.sql': 'CREATE TABLE ok (a int);',
      '0002_bad.sql': 'CREATE TABLE half (a int); SELECT * FROM does_not_exist;',
    });
    await expect(runMigrations(pool, dir)).rejects.toThrow(/does_not_exist/);
    const half = await pool.query("SELECT to_regclass('half') AS t");
    expect(half.rows[0]).toEqual({ t: null });
    const done = await pool.query('SELECT name FROM schema_migrations');
    expect(done.rows).toEqual([{ name: '0001_ok.sql' }]);
  });

  it('createDb gives a typed query builder over the pool', async () => {
    const { pool } = await fixture({});
    const db = createDb<{ thing: { a: number } }>(pool);
    await sql`CREATE TABLE thing (a int)`.execute(db);
    await db.insertInto('thing').values({ a: 7 }).execute();
    expect(await db.selectFrom('thing').select('a').execute()).toEqual([{ a: 7 }]);
  });

  it('rejects an invalid schema prefix', async () => {
    await expect(testSchemaPool(url!, 'bad; DROP')).rejects.toThrow(/Invalid schema prefix/);
  });

  it.each([
    [{ 'create.sql': 'SELECT 1;' }, /Bad migration file name/],
    [{ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' }, /Duplicate/],
  ])('validates file names %#', async (files, error) => {
    const { pool, dir } = await fixture(files);
    await expect(runMigrations(pool, dir)).rejects.toThrow(MigrationError);
    await expect(runMigrations(pool, dir)).rejects.toThrow(error);
  });

  it('serialises two runs on one schema, while another schema is not blocked', async () => {
    const { pool, dir } = await fixture({
      '0001_slow.sql': 'CREATE TABLE slow (a int); SELECT pg_sleep(1);',
    });
    const other = await fixture({ '0001_quick.sql': 'CREATE TABLE quick (a int);' });
    const first = runMigrations(pool, dir);
    await new Promise((r) => setTimeout(r, 200));
    // Another schema migrates while the first still holds its lock.
    const started = Date.now();
    await runMigrations(other.pool, other.dir);
    expect(Date.now() - started).toBeLessThan(900);
    // A second run on the same schema waits, then finds everything applied.
    const second = runMigrations(pool, dir);
    expect((await first).applied).toEqual(['0001_slow.sql']);
    expect(await second).toEqual({ applied: [], alreadyApplied: ['0001_slow.sql'] });
  });
});
