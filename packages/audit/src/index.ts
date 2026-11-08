import { fileURLToPath } from 'node:url';
export { AuditEventInput, AuditOutcome, PurposeOfUse, GENESIS_HASH } from './schema.ts';
export type { AuditEvent, AuditEventInputType } from './schema.ts';
export { AuditWriter, AuditSequenceConflictError, verifyChain, hashEvent } from './writer.ts';
export type { AuditStore, ChainVerification } from './writer.ts';
export { InMemoryAuditStore } from './memory-store.ts';
export { PostgresAuditStore } from './postgres-store.ts';
export type { AuditDatabase } from './postgres-store.ts';

/** Directory of this package's SQL migrations, for runMigrations() from @endo/db. */
export const AUDIT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
