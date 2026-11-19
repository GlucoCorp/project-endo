// Test helper: a session database in a fresh schema, with deployment-shaped roles (the owner
// runs migrations; the BFF connects as a member of endo_sessions_app). Tests only.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations } from '@endo/db';
import { SESSION_MIGRATIONS_DIR } from './index.ts';
import type { SessionDatabase } from './session-table.ts';

export interface TestSessionDb {
  readonly db: Kysely<SessionDatabase>;
  /** A superuser pool on the same schema, to age rows. */
  readonly admin: pg.Pool;
  close(): Promise<void>;
}

export async function createTestSessionDb(url: string): Promise<TestSessionDb> {
  const schema = `sessions_${randomBytes(6).toString('hex')}`;
  const ownerPw = randomBytes(16).toString('hex');
  const appPw = randomBytes(16).toString('hex');
  const at = (user: string, pw: string) => {
    const u = new URL(url);
    u.username = user;
    u.password = pw;
    u.searchParams.set('options', `-c search_path=${schema}`);
    return u.toString();
  };
  // A path inside this package, not input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const bootstrap = await readFile(
    fileURLToPath(new URL('../bootstrap/roles.sql', import.meta.url)),
    'utf8',
  );
  const su = new pg.Client({ connectionString: url });
  await su.connect();
  try {
    await su.query(bootstrap);
    for (const [role, pw, extra] of [
      ['sessions_owner_test', ownerPw, ''],
      ['sessions_bff_test', appPw, 'IN ROLE endo_sessions_app'],
    ] as const) {
      const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      // Role names and hex passwords are fixed or generated here, never external input.
      if (exists.rowCount === 0)
        await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
      else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
    }
    await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION sessions_owner_test`);
    await su.query(`GRANT USAGE ON SCHEMA ${schema} TO endo_sessions_app`);
  } finally {
    await su.end();
  }
  const owner = createPool(at('sessions_owner_test', ownerPw), {
    applicationName: 'endo-test-sessions-owner',
    max: 1,
  });
  try {
    await runMigrations(owner, SESSION_MIGRATIONS_DIR);
  } finally {
    await owner.end();
  }
  const base = new URL(url);
  const admin = new pg.Pool({
    connectionString: at(base.username, decodeURIComponent(base.password)),
  });
  const db = createDb<SessionDatabase>(
    createPool(at('sessions_bff_test', appPw), { applicationName: 'endo-test-sessions' }),
  );
  return {
    db,
    admin,
    close: async () => {
      await db.destroy();
      await admin.end();
    },
  };
}
