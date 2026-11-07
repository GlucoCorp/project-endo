# @endo/audit

**Purpose:** the audit event schema and hash-chained writer (spec 2.6, 12.9; RISK-R01, RISK-I02).

**Owners:** security engineering (CODEOWNERS). Named human reviewer required (spec 12.11).

## Public API

| Export                               | What it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `AuditEventInput`                    | Strict Zod schema. Opaque IDs, codes and enums only; no field can hold free text |
| `AuditWriter`                        | `write(input)` validates, assigns id, sequence, time and hash, then appends      |
| `verifyChain(events, previousHash?)` | Detects modified, removed or re-linked events                                    |
| `AuditStore`, `InMemoryAuditStore`   | Append-only store contract and its dev/test implementation                       |
| `GENESIS_HASH`                       | `prev_hash` of the first event                                                   |

## Rules

- If writing an audit event fails, the request that caused it fails. Never swallow audit errors.
- Health-data reads and writes audit in the same database transaction or through a guaranteed outbox (spec 2.6). The Postgres store and outbox arrive with the first health-data tables (M1).
- A daily anchor hash is published to a write-once bucket (infra slice).
