# Backups

Spec 12.8, RISK-D02. Owner: platform on-call. Applies to the three databases: clinical, identity, audit.

## What runs

| Layer                  | How                                                                                                       | Retention                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Point-in-time recovery | WAL archiving on each database (RPO 15 minutes)                                                           | 7 days                           |
| Daily snapshot         | `tools/backup.mjs` per database: `pg_dump -Fc` streamed through AES-256-GCM under a key from `kms/backup` | 35 days, object lock (immutable) |
| Copy                   | The encrypted dump and its manifest are copied to the separate backup account (write-only role)           | as above                         |

The dump is never written unencrypted. The manifest holds the IV, auth tag, the ciphertext's SHA-256 and row counts per table: no data.

## Daily job (per database)

```sh
node tools/backup.mjs --db endo_clinical --out /backups/clinical --key /run/secrets/backup.key \
  --user endo_backup
```

- `endo_backup` is a read-only role with `pg_read_all_data`; it is not the application role.
- The key is fetched at job start from `kms/backup` into memory-backed storage (`/run/secrets`) and never logged.
- Alert if the job fails or the manifest is missing (spec 15 dashboards: "backup success").

## What backups mean for erasure (REQ-009)

Backups expire on their schedule (35 days); they are not edited. A patient erased after a backup was taken still has rows in that backup, but her per-patient key is destroyed, so her encrypted fields (goal text, notes) are unreadable there. Any restore replays erasures before the system serves traffic: see `restore.md`.

## Checks

- Quarterly restore drill (`restore.md`), with the report filed under `docs/runbooks/drills/`.
- Monthly: list the backup account and confirm 35 days of objects with object lock in governance or compliance mode.
