import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export interface PoolOptions {
  /** Shown in pg_stat_activity; never include personal data. */
  readonly applicationName: string;
  readonly max?: number;
  /** Per-statement timeout (spec 12.3: timeouts everywhere). Default 5 s. */
  readonly statementTimeoutMs?: number;
}

/**
 * A pg pool with conservative defaults. TLS settings come from the connection string
 * (`sslmode=verify-full` in deployed environments, set by infrastructure).
 */
export function createPool(connectionString: string, options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 5000,
    idle_in_transaction_session_timeout: 10_000,
    connectionTimeoutMillis: 5000,
  });
}

/** Typed query builder over a pool (spec 8.3: Kysely; SQL stays visible and reviewable). */
export function createDb<Schema>(pool: pg.Pool): Kysely<Schema> {
  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}
