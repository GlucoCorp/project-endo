import { fileURLToPath } from 'node:url';
export { CONSENT_PURPOSES } from './schema.ts';
export type { ClinicalDatabase, ConsentPurpose, ConsentStatus } from './schema.ts';
export { withOrg, findLiveInvitation } from './org-scope.ts';
export {
  InMemoryInvitationStore,
  InMemoryMembershipStore,
  PostgresInvitationStore,
  PostgresMembershipStore,
} from './invitations.ts';
export type {
  ClinicianMembership,
  InvitationStore,
  MembershipStore,
  NewInvitation,
} from './invitations.ts';

export {
  InMemoryIdempotentInvitationStore,
  PostgresIdempotentInvitationStore,
} from './idempotent.ts';
export type {
  CreateInvitationOnce,
  IdempotencyKey,
  IdempotentInvitationStore,
  IdempotentOutcome,
  SealedResponse,
} from './idempotent.ts';
export { OUTBOX_MAX_ATTEMPTS, relayAuditOutbox } from './outbox.ts';
export { PostgresInvitationReservationStore } from './reservations.ts';
export type {
  AuditEvent,
  ClaimRequest,
  InvitationReservationStore,
  InvitationState,
  ReservationOutcome,
  ReservationRequest,
} from './reservations.ts';
export { InMemoryConsentStore, PostgresConsentStore } from './consents.ts';
export type { ConsentDecision, ConsentState, ConsentStore } from './consents.ts';
export type { RelayResult } from './outbox.ts';

/** Directory of this package's SQL migrations, for runMigrations() from @endo/db. */
export const CLINICAL_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
