# @endo/identity-store

**Purpose:** the identity vault's schema and per-person key store (spec 5.2, 11.1, 11.2; REQ-009; RISK-I01). It is the only store with names, emails and phone numbers. Only `services/identity` uses it.

**Owners:** security engineering. Named human reviewer required (identity data, crypto-shredding).

## Public API

| Export                    | What it does                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityDatabase`        | Kysely table types matching the migrations                                                                                                                                |
| `PostgresPersonKeyStore`  | Durable per-person data keys for `FieldCipher` with `kms/identity`. `destroy` deletes the key and leaves a tombstone; the database then refuses a new key for that person |
| `IDENTITY_MIGRATIONS_DIR` | SQL migrations; apply with `pnpm --filter @endo/identity-store migrate` (`ENDO_IDENTITY_MIGRATION_DATABASE_URL`) after `bootstrap/roles.sql`                              |

## Audit outbox (migration 0002)

`audit_outbox` holds audit events written in the same transaction as the change they describe. Only `endo_identity_relay` reads and acknowledges them, through `relayAuditOutbox` from `@endo/db`. The identity service can only add events. Run `bootstrap/roles.sql` again on existing clusters to create the relay role.

## Rules

- Every identity field is stored encrypted under the person's own key (`FieldCipher`, `kms/identity`). Never store a plaintext name, email or phone.
- Only the identity service connects, as a member of `endo_identity_app`. It cannot delete people, rewrite patient links or undo a shredding.
- Erasure (REQ-009) is crypto-shredding. `destroy` writes a tombstone, and the database deletes the key in the same transaction. Key creation and destruction take the same per-person lock. The service cannot delete a key any other way.

## What erasure guarantees

- Once the shredding commits, no query can return her key and no new key can be created, so her encrypted fields cannot be decrypted through the system.
- Copies of the wrapped key stay in dead row versions until VACUUM, and in the write-ahead log and backups until they expire. REQ-009 allows normal backup expiry. Before a restored database serves traffic, the tombstones must be replayed (restore runbook, M6).
- If immediate destruction of every copy is ever required, the next step is a separately revocable key per person in the key manager (OpenBao), so revoking that key makes all copies useless.
