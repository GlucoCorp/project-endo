import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations } from '@endo/db';
import { IDENTITY_MIGRATIONS_DIR, type IdentityDatabase } from '@endo/identity-store';

/** A migrated identity schema for integration tests, with the real roles (SYNTHETIC data only). */
export interface TestIdentityDb {
  /** Superuser in the schema: direct SQL that bypasses the service's privileges. */
  readonly admin: pg.Pool;
  /** The outbox relay role. */
  readonly relay: pg.Pool;
  /** The service role (endo_identity_app), as the identity service connects. */
  readonly db: Kysely<IdentityDatabase>;
  close(): Promise<void>;
}

/**
 * Creates a fresh schema owned by its own role and runs the identity migrations as that owner.
 * `prefix` keeps each test file's login roles apart: their passwords are reset on every run, and
 * files run in parallel.
 */
export async function setupIdentityTestDb(url: string, prefix: string): Promise<TestIdentityDb> {
  if (!/^[a-z]+$/.test(prefix)) throw new Error('prefix must be lowercase letters');
  const schema = `${prefix}_${randomBytes(6).toString('hex')}`;
  const roles = {
    owner: `${prefix}_owner_test`,
    api: `${prefix}_api_test`,
    relay: `${prefix}_relay_test`,
  };
  const pw = {
    owner: randomBytes(16).toString('hex'),
    api: randomBytes(16).toString('hex'),
    relay: randomBytes(16).toString('hex'),
  };
  const at = (user: string, password: string) => {
    const u = new URL(url);
    u.username = user;
    u.password = password;
    u.searchParams.set('options', `-c search_path=${schema}`);
    return u.toString();
  };
  // A fixed path inside this repository, never input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const bootstrap = await readFile(
    fileURLToPath(
      new URL('../../../../packages/identity-store/bootstrap/roles.sql', import.meta.url),
    ),
    'utf8',
  );
  const su = new pg.Client({ connectionString: url });
  await su.connect();
  try {
    await su.query(bootstrap);
    for (const [role, password, extra] of [
      [roles.owner, pw.owner, ''],
      [roles.api, pw.api, 'IN ROLE endo_identity_app'],
      [roles.relay, pw.relay, 'IN ROLE endo_identity_relay'],
    ] as const) {
      const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      // Role names come from a checked prefix and passwords are generated hex, never input.
      if (exists.rowCount === 0)
        await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' ${extra}`);
      else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    }
    await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${roles.owner}`);
  } finally {
    await su.end();
  }
  const owner = createPool(at(roles.owner, pw.owner), { applicationName: 'endo-test', max: 1 });
  try {
    await runMigrations(owner, IDENTITY_MIGRATIONS_DIR);
  } finally {
    await owner.end();
  }
  const base = new URL(url);
  const admin = new pg.Pool({ connectionString: at(base.username, base.password) });
  const relay = new pg.Pool({ connectionString: at(roles.relay, pw.relay) });
  const db = createDb<IdentityDatabase>(
    createPool(at(roles.api, pw.api), { applicationName: 'endo-test' }),
  );
  return {
    admin,
    relay,
    db,
    close: async () => {
      await db.destroy();
      await relay.end();
      await admin.end();
    },
  };
}
