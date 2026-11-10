import type { Generated } from 'kysely';
import type { AuditOutboxTable } from '@endo/db';

/** Table shapes for Kysely. Match migrations/0001_person_vault.sql and later. */
export interface IdentityDatabase {
  person: {
    id: string;
    idp_subject: string | null;
    email_encrypted: string | null;
    phone_encrypted: string | null;
    display_name_encrypted: string | null;
    created_at: Generated<Date>;
    deleted_at: Date | null;
  };
  person_key: {
    person_id: string;
    wrapped: Buffer;
    created_at: Generated<Date>;
  };
  person_key_shredded: {
    person_id: string;
    shredded_at: Generated<Date>;
  };
  /** Migration 0002 (spec 2.6). The service may only insert; the relay reads and acknowledges. */
  audit_outbox: AuditOutboxTable;
  /** Migration 0003 (ADR-0021 section 10). The database refuses transitions the machine forbids. */
  enrolment_transaction: {
    id: string;
    invitation_id: string;
    org_id: string;
    status: string;
    started_at: Date;
    expires_at: Date;
    state_deadline: Date | null;
    binding_hash: string;
    code_wrapped_key: string | null;
    code_mac: string | null;
    provisional_subject: string | null;
    decisions: unknown;
    person_id: string | null;
    patient_id: string | null;
    cancel_requested: string | null;
    cancel_reason: string | null;
    activation_step: Generated<number>;
    version: Generated<number>;
    updated_at: Generated<Date>;
  };
  /** Migration 0004 (ADR-0021 section 3). Wrong codes per invitation; the fifth locks it. */
  enrolment_invitation_guard: {
    invitation_id: string;
    wrong_attempts: Generated<number>;
    locked_until: Generated<Date | null>;
    version: Generated<number>;
    updated_at: Generated<Date>;
  };
  patient_link: {
    person_id: string;
    patient_record_id: string;
    org_id: string;
    created_at: Generated<Date>;
  };
}
