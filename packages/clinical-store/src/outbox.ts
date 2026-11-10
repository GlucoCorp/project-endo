// The relay is shared by every store with an audit outbox; it lives in @endo/db.
export {
  OUTBOX_MAX_ATTEMPTS,
  PermanentPublishError,
  outboxAlert,
  outboxHealth,
  relayAuditOutbox,
} from '@endo/db';
export type { OutboxHealth, RelayResult } from '@endo/db';
