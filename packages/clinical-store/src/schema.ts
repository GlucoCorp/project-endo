import type { Generated } from 'kysely';

/** Spec 13.1 consent purposes. Order is not significant. */
export const CONSENT_PURPOSES = [
  'self_tracking',
  'share_with_care_team',
  'research_deidentified',
  'org_aggregate_reporting',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type ConsentStatus = 'granted' | 'declined' | 'revoked';

/** Table shapes for Kysely. Match migrations/0001_enrolment_consent.sql. */
export interface ClinicalDatabase {
  organization: { id: string; region: string; name: string; created_at: Generated<Date> };
  clinician: {
    id: string;
    org_id: string;
    identity_ref: string;
    role: 'clinician' | 'org_admin';
    active: Generated<boolean>;
    created_at: Generated<Date>;
  };
  patient_record: {
    id: string;
    org_id: string;
    identity_ref: string;
    birth_year: number | null;
    preferred_language: string | null;
    created_at: Generated<Date>;
  };
  enrolment_invitation: {
    id: string;
    org_id: string;
    created_by: string;
    token_hash: string;
    created_at: Generated<Date>;
    expires_at: Date;
    claimed_at: Date | null;
    patient_id: string | null;
    revoked_at: Date | null;
  };
  idempotency_record: {
    org_id: string;
    actor_ref: string;
    operation: string;
    idem_key: string;
    request_hash: string;
    status_code: number;
    response_wrapped_key: string | null;
    response_envelope: string | null;
    created_at: Generated<Date>;
    expires_at: Generated<Date>;
  };
  audit_outbox: {
    id: string;
    seq: Generated<string>;
    event: unknown;
    created_at: Generated<Date>;
    published_at: Date | null;
    attempts: Generated<number>;
    last_error: string | null;
  };
  consent: {
    id: string;
    patient_id: string;
    org_id: string;
    purpose: ConsentPurpose;
    status: ConsentStatus;
    version: number;
    decided_at: Generated<Date>;
  };
}
