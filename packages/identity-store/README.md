# @endo/identity-store

**Purpose:** the identity vault's schema and per-person key store (spec 5.2, 11.1, 11.2; REQ-009; RISK-I01). It is the only store with names, emails and phone numbers. Only `services/identity` uses it.

**Owners:** security engineering. Named human reviewer required (identity data, crypto-shredding).

## Public API

| Export                    | What it does                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityDatabase`        | Kysely table types matching the migrations                                                                                                                                |
| `PostgresPersonKeyStore`  | Durable per-person data keys for `FieldCipher` with `kms/identity`. `destroy` deletes the key and leaves a tombstone; the database then refuses a new key for that person |
| `IDENTITY_MIGRATIONS_DIR` | SQL migrations; apply with `pnpm --filter @endo/identity-store migrate` (`ENDO_IDENTITY_MIGRATION_DATABASE_URL`) after `bootstrap/roles.sql`                              |

## Rules

- Every identity field is stored encrypted under the person's own key (`FieldCipher`, `kms/identity`). Never store a plaintext name, email or phone.
- Only the identity service connects, as a member of `endo_identity_app`. It cannot delete people, rewrite patient links or undo a shredding.
- Erasure (REQ-009) is crypto-shredding: destroy the person's key; the encrypted fields become unrecoverable.
