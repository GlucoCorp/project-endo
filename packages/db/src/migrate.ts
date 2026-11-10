import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/**
 * Minimal forward-only runner for hand-written, reviewed SQL migrations (spec 8.3, 18.3).
 *
 * - Files are `NNNN_snake_name.sql`, applied in order, each in its own transaction.
 * - The SHA-256 of each applied file is recorded. Editing an applied migration is an error:
 *   migrations are immutable once applied; write a new one (expand/migrate/contract).
 * - A Postgres advisory lock stops two deployers migrating the same schema at once. It is keyed
 *   by schema, so migrations of unrelated schemas in one database (test suites) never queue
 *   behind each other. Deployments use one schema per database, so nothing changes there.
 */

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Advisory lock keyed by the schema being migrated (current_schema: the first search_path entry).
// The key is computed once, before any migration runs: a migration may change search_path, and
// the unlock must release exactly the lock that was taken.
const LOCK_KEY = "SELECT hashtextextended('endo-migrate:' || current_schema(), 0)::text AS key";

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export async function runMigrations(pool: pg.Pool, dir: string): Promise<MigrationResult> {
  // The directory is chosen by our own code, never by a request.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  for (const n of names) {
    if (!FILE_RE.test(n)) throw new MigrationError(`Bad migration file name: ${n}`);
  }
  const versions = names.map((n) => n.slice(0, 4));
  if (new Set(versions).size !== versions.length) {
    throw new MigrationError('Duplicate migration version number');
  }

  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  let key: string | undefined;
  try {
    key = (await client.query<{ key: string }>(LOCK_KEY)).rows[0]?.key;
    await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const known = new Map(done.rows.map((r) => [r.name, r.checksum]));

    for (const name of names) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql = await readFile(join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const previous = known.get(name);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new MigrationError(`Applied migration ${name} has been modified`);
        }
        alreadyApplied.push(name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(name);
    }
  } finally {
    if (key !== undefined)
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
    client.release();
  }
  return { applied, alreadyApplied };
}
