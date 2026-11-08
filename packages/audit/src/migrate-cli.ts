// Applies the audit-store migrations: `pnpm --filter @endo/audit migrate`.
// Run by the release pipeline as a separate step before services start (spec 18.3), with a
// migration-owner role; services themselves connect as members of endo_audit_app.
import { createPool, runMigrations } from '@endo/db';
import { AUDIT_MIGRATIONS_DIR } from './index.ts';

const url = process.env['ENDO_AUDIT_MIGRATION_DATABASE_URL'];
if (!url) {
  process.stderr.write('ENDO_AUDIT_MIGRATION_DATABASE_URL is not set\n');
  process.exit(1);
}

const pool = createPool(url, { applicationName: 'endo-audit-migrate', max: 1 });
try {
  const result = await runMigrations(pool, AUDIT_MIGRATIONS_DIR);
  process.stdout.write(
    `audit migrations: applied ${result.applied.length}, already applied ${result.alreadyApplied.length}\n`,
  );
} catch (error) {
  // Migration errors name files and SQL objects only; never data.
  process.stderr.write(
    `audit migrations failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
