import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool } from './pool.ts';

/**
 * Connection string for integration tests: a throwaway Postgres with SYNTHETIC data only.
 *
 * - CI provides `ENDO_TEST_DATABASE_URL` from a service container; there, a missing URL is an
 *   error so integration tests can never be skipped silently.
 * - Locally, start one with `pnpm db:test:up`; without it, integration tests are skipped and
 *   coverage of database code is measured only in CI.
 */
export function testDatabaseUrl(): string | undefined {
  const url = process.env['ENDO_TEST_DATABASE_URL'];
  if (!url && process.env['CI'] === 'true') {
    throw new Error('ENDO_TEST_DATABASE_URL must be set in CI');
  }
  return url || undefined;
}

/**
 * A pool whose search_path is a brand-new schema, so each test file (or test) gets isolated
 * tables in the shared test database. Close it with `pool.end()`.
 */
export async function testSchemaPool(
  url: string,
  prefix: string,
): Promise<{ pool: pg.Pool; schema: string }> {
  if (!/^[a-z][a-z0-9_]{0,20}$/.test(prefix)) throw new Error('Invalid schema prefix');
  const schema = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const sep = url.includes('?') ? '&' : '?';
  const pool = createPool(`${url}${sep}options=-c%20search_path%3D${schema}`, {
    applicationName: 'endo-test',
  });
  return { pool, schema };
}
