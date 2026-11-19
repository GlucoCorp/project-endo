import { fileURLToPath } from 'node:url';
export { SessionTable, newSessionToken } from './session-table.ts';
export type { NewSessionRow, SessionDatabase, StoredSession } from './session-table.ts';

/** Directory of this package's SQL migrations, for runMigrations() from @endo/db. */
export const SESSION_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
