# Data inventory

Version 2 (M0) · Spec 11.3: every stored column has an entry here stating purpose, legal basis, retention and sensitivity. `pnpm check:inventory` (run in CI) fails if a migration creates a column that is not listed here as `table.column`.

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

## Clinical, identity and other stores

Not yet created. Entries are added in the same PR as each migration (spec 0 rule 9).
