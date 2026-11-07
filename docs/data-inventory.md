# Data inventory

Version 1 (M0) · Spec 11.3: every stored column has an entry here stating purpose, legal basis, retention and sensitivity. A CI check comparing migrations against this file is added with the first migration (M1).

Sensitivity levels: **S0** no personal data · **S1** pseudonymous operational · **S2** pseudonymous health data · **S3** identity data or free text (field-encrypted).

## Audit store (`kms/audit`)

The store is in-memory in M0; this schema becomes the Postgres table in M1.

| Column                         | Purpose                        | Legal basis                                               | Retention | Sensitivity |
| ------------------------------ | ------------------------------ | --------------------------------------------------------- | --------- | ----------- |
| `id`                           | Unique event id (UUIDv7)       | Legal obligation / legitimate interest (security logging) | 7 years   | S0          |
| `sequence`                     | Chain order                    | as above                                                  | 7 years   | S0          |
| `occurred_at`                  | When                           | as above                                                  | 7 years   | S1          |
| `prev_hash`, `hash`            | Tamper evidence                | as above                                                  | 7 years   | S0          |
| `actor.id`                     | Who (opaque)                   | as above                                                  | 7 years   | S1          |
| `actor.role`                   | Role at the time               | as above                                                  | 7 years   | S1          |
| `action`                       | What (code)                    | as above                                                  | 7 years   | S1          |
| `resource.type`, `resource.id` | On what (opaque)               | as above                                                  | 7 years   | S1          |
| `org_id`                       | Organisation (opaque)          | as above                                                  | 7 years   | S1          |
| `purpose_of_use`               | Why (enum)                     | as above                                                  | 7 years   | S1          |
| `outcome`, `reason`            | Result and machine reason code | as above                                                  | 7 years   | S1          |
| `request_id`                   | Correlation                    | as above                                                  | 7 years   | S0          |

Legal basis per region: `TODO_LEGAL` (spec Section 24 item 4).

## Clinical, identity and other stores

Not yet created. Entries are added in the same PR as each migration (spec 0 rule 9).
