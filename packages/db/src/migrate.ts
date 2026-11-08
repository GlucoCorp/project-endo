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
 * - A Postgres advisory lock stops two deployers migrating the same database at once.
 */

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Arbitrary constant: "endo" + "migr" as ASCII, fits in a signed 64-bit lock key.
const LOCK_KEY = '7310598722425860722';

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
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
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
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return { applied, alreadyApplied };
}
