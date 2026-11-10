# @endo/audit

**Purpose:** the audit event schema, hash-chained writer and durable PostgreSQL store (spec 2.6, 12.9; RISK-R01, RISK-I02; ADR-0008, ADR-0013).

**Owners:** security engineering (CODEOWNERS). Named human reviewer required (spec 12.11).

## Public API

| Export                                | What it does                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuditEventInput`                     | Strict Zod schema. Opaque IDs, codes and enums only; no field can hold free text                                                                                                                         |
| `AuditWriter`                         | `write(input)` validates, assigns id, sequence, time and hash, then appends through the store's exclusive `appendNext`, so instances queue instead of racing; retries if a writer outside that lock wins |
| `verifyChain(events, previousHash?)`  | Detects modified, removed or re-linked events                                                                                                                                                            |
| `AuditStore`, `InMemoryAuditStore`    | Append-only store contract and its dev/test implementation                                                                                                                                               |
| `PostgresAuditStore`, `AuditDatabase` | Durable store. The database itself refuses UPDATE, DELETE and TRUNCATE, rejects free text, and checks each insert links to its predecessor                                                               |
| `AuditSequenceConflictError`          | Raised when another process appended first                                                                                                                                                               |
| `AUDIT_MIGRATIONS_DIR`                | SQL migrations; apply with `pnpm --filter @endo/audit migrate` (`ENDO_AUDIT_MIGRATION_DATABASE_URL`)                                                                                                     |
| `GENESIS_HASH`                        | `prev_hash` of the first event                                                                                                                                                                           |

## Rules

- If writing an audit event fails, the request that caused it fails. Never swallow audit errors.
- Health-data reads and writes audit in the same database transaction or through a guaranteed outbox (spec 2.6). The clinical store's `audit_outbox` (relayed by the API, at least once) is the first such outbox.
- Services connect as members of `endo_audit_app` (SELECT and INSERT only). Migrations run as a separate release step with an owner role.
- A daily anchor hash is published to a write-once bucket (infra slice).
