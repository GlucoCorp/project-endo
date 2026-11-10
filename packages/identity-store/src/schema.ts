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
  patient_link: {
    person_id: string;
    patient_record_id: string;
    org_id: string;
    created_at: Generated<Date>;
  };
}
