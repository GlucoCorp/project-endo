// Applies the identity-store migrations: `pnpm --filter @endo/session-store migrate`.
// Run by the release pipeline as a separate step before services start (spec 18.3), with a
// migration-owner role; services themselves connect as members of endo_sessions_app.
import { createPool, runMigrations } from '@endo/db';
import { SESSION_MIGRATIONS_DIR } from './index.ts';

const url = process.env['ENDO_SESSION_MIGRATION_DATABASE_URL'];
if (!url) {
  process.stderr.write('ENDO_SESSION_MIGRATION_DATABASE_URL is not set\n');
  process.exit(1);
}

const pool = createPool(url, { applicationName: 'endo-sessions-migrate', max: 1 });
try {
  const result = await runMigrations(pool, SESSION_MIGRATIONS_DIR);
  process.stdout.write(
    `session migrations: applied ${result.applied.length}, already applied ${result.alreadyApplied.length}\n`,
  );
} catch (error) {
  // Migration errors name files and SQL objects only; never data.
  process.stderr.write(
    `session migrations failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
