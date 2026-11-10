// The relay is shared by every store with an audit outbox; it lives in @endo/db.
export { OUTBOX_MAX_ATTEMPTS, relayAuditOutbox } from '@endo/db';
export type { RelayResult } from '@endo/db';
