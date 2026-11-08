import { fileURLToPath } from 'node:url';
export type { IdentityDatabase } from './schema.ts';
export { PostgresPersonKeyStore } from './key-store.ts';

/** Directory of this package's SQL migrations, for runMigrations() from @endo/db. */
export const IDENTITY_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
