import type { Generated } from 'kysely';
import type { AuditOutboxTable } from '@endo/db';

/** Spec 13.1 consent purposes. Order is not significant. */
export const CONSENT_PURPOSES = [
  'self_tracking',
  'share_with_care_team',
  'research_deidentified',
  'org_aggregate_reporting',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type ConsentStatus = 'granted' | 'declined' | 'revoked';

/** Table shapes for Kysely. Match migrations/0001_enrolment_consent.sql and later. */
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
    /** Migration 0005: the coordinator transaction holding it (ADR-0021 section 6). */
    reserved_by: string | null;
    reserved_at: Date | null;
  };
  /** Migration 0005: transactions whose reservation was released, never to reserve again. */
  enrolment_reservation_fence: {
    transaction_id: string;
    org_id: string;
    invitation_id: string;
    released_at: Generated<Date>;
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
  audit_outbox: AuditOutboxTable;
  /** View: the latest decision per patient and purpose (migration 0001). Read-only. */
  consent_current: {
    id: string;
    seq: string;
    patient_id: string;
    org_id: string;
    purpose: ConsentPurpose;
    status: ConsentStatus;
    version: number;
    decided_at: Date;
  };
  consent: {
    id: string;
    patient_id: string;
    org_id: string;
    purpose: ConsentPurpose;
    status: ConsentStatus;
    version: number;
    decided_at: Generated<Date>;
    /** Migration 0007: when she chose, at enrolment only; shortly before `decided_at`. */
    chosen_at: Date | null;
  };
  /** Migration 0008: per-patient wrapped data keys (spec 11.2) and their shredding tombstones. */
  patient_key: { patient_id: string; org_id: string; wrapped: Buffer; created_at: Generated<Date> };
  patient_key_shredded: { patient_id: string; org_id: string; shredded_at: Generated<Date> };
  treatment_episode: {
    id: string;
    org_id: string;
    patient_id: string;
    prescriber_id: string;
    line_id: string;
    previous_episode_id: string | null;
    treatment_system: string;
    treatment_code: string;
    adherence_mode: AdherenceMode;
    dose_text: string;
    start_date: string;
    review_interval_weeks: number;
    review_date: Generated<string>;
    time_zone: string | null;
    instrument_version: string;
    /** Migration 0009: the clinician's Idempotency-Key for the draft. */
    creation_key: string;
    /** Migration 0009: her Idempotency-Key for the confirmation, set once. */
    confirm_key: string | null;
    status: Generated<EpisodeStatus>;
    created_at: Generated<Date>;
    confirmed_at: Generated<Date | null>;
    closed_at: Generated<Date | null>;
  };
  goal: {
    id: string;
    org_id: string;
    patient_id: string;
    episode_id: string;
    goal_template_code: string | null;
    text_encrypted: string | null;
    created_at: Generated<Date>;
  };
  check_in: {
    id: string;
    org_id: string;
    patient_id: string;
    episode_id: string;
    week_index: number;
    idempotency_key: string;
    request_hash: string;
    answers: unknown;
    instrument_version: string;
    client_created_at: Date;
    submitted_at: Generated<Date>;
    is_late: Generated<boolean>;
  };
  red_flag_event: {
    id: string;
    org_id: string;
    patient_id: string;
    episode_id: string;
    idempotency_key: string;
    flags: string[];
    instrument_version: string;
    shown_at: Date;
    acknowledged_at: Date | null;
    recorded_at: Generated<Date>;
    team_notified_at: Generated<Date | null>;
  };
  /** Migration 0010: verdict generation attempts, shadow mode (REQ-004). */
  verdict: {
    id: string;
    org_id: string;
    patient_id: string;
    episode_id: string;
    outcome: 'generated' | 'not_generated';
    reason: string | null;
    verdict_code: string | null;
    secondary_code: string | null;
    modifiers: Generated<string[]>;
    ruleset_version: string;
    ruleset_digest: string;
    instrument_version: string;
    input_hash: string | null;
    explanation: unknown;
    generated_by: 'system' | 'on_demand';
    requested_by: string | null;
    shadow: Generated<boolean>;
    generated_at: Generated<Date>;
  };
  /** Migration 0011: push subscriptions (endpoint encrypted per patient) and sent reminders. */
  push_subscription: {
    id: string;
    org_id: string;
    patient_id: string;
    endpoint_encrypted: string;
    endpoint_hash: string;
    remind_hour: Generated<number>;
    time_zone: string;
    created_at: Generated<Date>;
  };
  reminder_sent: {
    episode_id: string;
    week_index: number;
    org_id: string;
    patient_id: string;
    sent_at: Generated<Date>;
  };
  /** Migration 0012: review decisions and pre-surgery checks (M4). */
  review_decision: {
    id: string;
    org_id: string;
    patient_id: string;
    episode_id: string;
    verdict_id: string | null;
    clinician_id: string;
    decision_code: 'continue' | 'switch' | 'add' | 'refer' | 'stop';
    note_encrypted: string | null;
    next_episode_id: string | null;
    added_episode_id: string | null;
    idempotency_key: string;
    request_hash: string;
    decided_at: Generated<Date>;
  };
  surgery_check: {
    id: string;
    org_id: string;
    patient_id: string;
    clinician_id: string;
    procedure_code: string;
    snapshot: unknown;
    acknowledged_at: Generated<Date>;
    idempotency_key: string;
  };
}

export type EpisodeStatus = 'draft' | 'active' | 'in_review' | 'closed';
export type AdherenceMode = 'daily' | 'device_or_injection';
