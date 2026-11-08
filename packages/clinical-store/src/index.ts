import { fileURLToPath } from 'node:url';
export { CONSENT_PURPOSES } from './schema.ts';
export type { ClinicalDatabase, ConsentPurpose, ConsentStatus } from './schema.ts';
export { withOrg, findLiveInvitation } from './org-scope.ts';

/** Directory of this package's SQL migrations, for runMigrations() from @endo/db. */
export const CLINICAL_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
