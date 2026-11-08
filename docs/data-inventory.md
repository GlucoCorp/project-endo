# Data inventory

Version 3 (M1) · Spec 11.3: every stored column has an entry here stating purpose, legal basis, retention and sensitivity. `pnpm check:inventory` (run in CI) fails if a migration creates a column that is not listed here as `table.column`.

Sensitivity levels: **S0** no personal data · **S1** pseudonymous operational · **S2** pseudonymous health data · **S3** identity data or free text (field-encrypted).

## Audit store (`kms/audit`) — `packages/audit/migrations`

| Column                       | Purpose                                    | Legal basis                                               | Retention | Sensitivity |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------- | --------- | ----------- |
| `audit_event.sequence`       | Chain order                                | Legal obligation / legitimate interest (security logging) | 7 years   | S0          |
| `audit_event.id`             | Unique event id (UUIDv7)                   | as above                                                  | 7 years   | S0          |
| `audit_event.occurred_at`    | When                                       | as above                                                  | 7 years   | S1          |
| `audit_event.prev_hash`      | Tamper evidence: link to previous event    | as above                                                  | 7 years   | S0          |
| `audit_event.hash`           | Tamper evidence: this event's hash         | as above                                                  | 7 years   | S0          |
| `audit_event.actor_id`       | Who (opaque id; null if unauthenticated)   | as above                                                  | 7 years   | S1          |
| `audit_event.actor_role`     | Role at the time                           | as above                                                  | 7 years   | S1          |
| `audit_event.action`         | What (code)                                | as above                                                  | 7 years   | S1          |
| `audit_event.resource_type`  | On what kind of record (code)              | as above                                                  | 7 years   | S1          |
| `audit_event.resource_id`    | On which record (opaque id)                | as above                                                  | 7 years   | S1          |
| `audit_event.org_id`         | Organisation (opaque id)                   | as above                                                  | 7 years   | S1          |
| `audit_event.purpose_of_use` | Why (enum)                                 | as above                                                  | 7 years   | S1          |
| `audit_event.outcome`        | Result (enum)                              | as above                                                  | 7 years   | S1          |
| `audit_event.reason`         | Machine reason code for denials and errors | as above                                                  | 7 years   | S1          |
| `audit_event.request_id`     | Correlation with logs and traces           | as above                                                  | 7 years   | S0          |

Legal basis per region: `TODO_LEGAL` (spec Section 24 item 4).

## Operational tables

| Column                         | Purpose                                     | Legal basis                      | Retention        | Sensitivity |
| ------------------------------ | ------------------------------------------- | -------------------------------- | ---------------- | ----------- |
| `schema_migrations.name`       | Which migration was applied (`packages/db`) | Legitimate interest (operations) | Life of database | S0          |
| `schema_migrations.checksum`   | Detects edits to applied migrations         | as above                         | Life of database | S0          |
| `schema_migrations.applied_at` | When it was applied                         | as above                         | Life of database | S0          |

## Identity provider (Keycloak, `keycloak` database on the identity instance)

Keycloak owns this schema; we configure it in `infra/modules/platform/realm/` (ADR-0015).

| Data                                      | Purpose                                 | Legal basis                           | Retention                    | Sensitivity |
| ----------------------------------------- | --------------------------------------- | ------------------------------------- | ---------------------------- | ----------- |
| User account (id, username, email)        | Sign-in and enrolment                   | Contract / consent to use the service | Life of account              | S3          |
| WebAuthn credential (public key, AAGUID)  | Passkey sign-in                         | as above                              | Life of credential           | S1          |
| Login and credential events (user id, IP) | Security monitoring, brute-force checks | Legitimate interest (security)        | 30 days (`eventsExpiration`) | S3          |
| Admin events (no representations)         | Who changed realm or user settings      | Legitimate interest (security)        | 30 days                      | S1          |

## Clinical store (`kms/clinical`) — `packages/clinical-store/migrations`

No names, emails, phones or addresses (spec 5.1). Every table has row-level security on `app.org_id`. Consent rows are append-only.

| Column                              | Purpose                                                                | Legal basis                                                      | Retention                                                                   | Sensitivity |
| ----------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| `organization.id`                   | Organisation identifier (UUIDv7)                                       | Contract with the organisation                                   | Life of contract                                                            | S0          |
| `organization.region`               | Hosting region; drives data localisation                               | as above                                                         | as above                                                                    | S0          |
| `organization.name`                 | Clinic name shown to its patients and staff                            | as above                                                         | as above                                                                    | S0          |
| `organization.created_at`           | When onboarded                                                         | as above                                                         | as above                                                                    | S0          |
| `clinician.id`                      | Clinician identifier in the clinical store                             | Contract (employment at the organisation)                        | Life of account                                                             | S1          |
| `clinician.org_id`                  | Organisation membership (authorisation, RLS)                           | as above                                                         | as above                                                                    | S1          |
| `clinician.identity_ref`            | Opaque pointer to the identity vault; no identity data here            | as above                                                         | as above                                                                    | S1          |
| `clinician.role`                    | `clinician` or `org_admin` (spec 3.1)                                  | as above                                                         | as above                                                                    | S1          |
| `clinician.active`                  | Deactivated clinicians lose access                                     | as above                                                         | as above                                                                    | S1          |
| `clinician.created_at`              | When added                                                             | as above                                                         | as above                                                                    | S1          |
| `patient_record.id`                 | Pseudonymous patient identifier                                        | Explicit consent (`self_tracking`); health data special category | Active account + regional clinical-record period (`TODO_LEGAL`)             | S1          |
| `patient_record.org_id`             | Treating organisation (authorisation, RLS)                             | as above                                                         | as above                                                                    | S1          |
| `patient_record.identity_ref`       | Opaque pointer to the identity vault                                   | as above                                                         | as above                                                                    | S1          |
| `patient_record.birth_year`         | Year only, for age-band reporting; optional                            | as above                                                         | as above                                                                    | S2          |
| `patient_record.preferred_language` | Language for her app and messages                                      | as above                                                         | as above                                                                    | S1          |
| `patient_record.created_at`         | When enrolled                                                          | as above                                                         | as above                                                                    | S1          |
| `enrolment_invitation.id`           | Invitation identifier                                                  | Legitimate interest of the organisation (inviting its patient)   | Until claimed or expired, then 90 days for audit correlation (`TODO_LEGAL`) | S0          |
| `enrolment_invitation.org_id`       | Issuing organisation                                                   | as above                                                         | as above                                                                    | S0          |
| `enrolment_invitation.created_by`   | Clinician who issued it                                                | as above                                                         | as above                                                                    | S1          |
| `enrolment_invitation.token_hash`   | SHA-256 of the single-use link token; the token itself is never stored | as above                                                         | as above                                                                    | S0          |
| `enrolment_invitation.created_at`   | Issue time                                                             | as above                                                         | as above                                                                    | S0          |
| `enrolment_invitation.expires_at`   | At most 7 days after issue (REQ-001)                                   | as above                                                         | as above                                                                    | S0          |
| `enrolment_invitation.claimed_at`   | When the link was used (single use)                                    | as above                                                         | as above                                                                    | S1          |
| `enrolment_invitation.patient_id`   | Patient record created by the claim                                    | as above                                                         | as above                                                                    | S1          |
| `enrolment_invitation.revoked_at`   | When the clinic cancelled the link                                     | as above                                                         | as above                                                                    | S0          |
| `consent.id`                        | Consent decision identifier                                            | Legal obligation to evidence consent (spec 13.1)                 | Life of account + regional limitation period (`TODO_LEGAL`)                 | S1          |
| `consent.seq`                       | Database-assigned order of decisions; the highest is current           | as above                                                         | as above                                                                    | S0          |
| `consent.patient_id`                | Whose decision                                                         | as above                                                         | as above                                                                    | S1          |
| `consent.org_id`                    | Organisation (RLS)                                                     | as above                                                         | as above                                                                    | S1          |
| `consent.purpose`                   | One of the four spec 13.1 purposes                                     | as above                                                         | as above                                                                    | S1          |
| `consent.status`                    | `granted`, `declined` (at enrolment) or `revoked` (later withdrawal)   | as above                                                         | as above                                                                    | S2          |
| `consent.version`                   | Version of the explanation she saw                                     | as above                                                         | as above                                                                    | S1          |
| `consent.decided_at`                | When she decided                                                       | as above                                                         | as above                                                                    | S1          |

## Identity vault and other stores

Not yet created. Entries are added in the same PR as each migration (spec 0 rule 9).
