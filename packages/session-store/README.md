# @endo/session-store

**Purpose:** durable browser sessions for the BFFs (ADR-0033): one table in a separate `sessions` database, tokens stored only as SHA-256, idle and absolute expiry checked by the database on every read (so every replica agrees), atomic rotation, back-channel logout by Keycloak session or subject, and a sweep for expired rows.

**Owners:** security engineering. Named human reviewer required.

## Public API

| Export                   | What                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `SessionTable`           | `insert`, `get` (with or without counting as activity), `patch`, `rotate`, `remove`, `removeMatching`, `sweep` |
| `newSessionToken`        | An opaque 256-bit token for the cookie                                                                         |
| `SESSION_MIGRATIONS_DIR` | Migrations; apply with `pnpm --filter @endo/session-store migrate` (`ENDO_SESSION_MIGRATION_DATABASE_URL`)     |

`bootstrap/roles.sql` creates `endo_sessions_app`; each BFF's login role is a member.
