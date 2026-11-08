# ADR-0008: Hash-chained, content-free audit events

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 2.6, 12.9; RISK-R01, RISK-I02

## Context

Every read or write of health data creates an audit event in the same transaction or a guaranteed outbox (2.6). Events carry actor, role, action, resource type and opaque ID, purpose of use, outcome, timestamp and request ID, never content, in an append-only, hash-chained store with a daily anchor (12.9).

## Decision

- `AuditEventInput` is a strict Zod schema: only UUIDs, dotted lower-case codes and enums. No field can hold free text; unknown keys are rejected.
- `AuditWriter` assigns `id` (UUIDv7), `sequence`, `occurred_at`, `prev_hash` and `hash = SHA-256(canonical JSON array of fields in a fixed order)`. Genesis `prev_hash` is 64 zeros.
- Writes are serialised in-process; the store contract requires `sequence = head + 1`, which serialises across processes (Postgres: unique constraint on `sequence`, retry on conflict).
- `verifyChain(events, previousHash)` detects modified, removed and re-linked events; ranges verify from a published anchor hash.
- **Audit failure fails the request.** The API audits the authorisation decision before any handler runs.
- Hash comparisons use `timingSafeEqual`.

## Consequences

- A global sequence is a write hotspot. Expected volume (spec 19.9: 10k check-ins/hour/region) is well within one Postgres row lock per event; revisit with per-partition chains if load tests disagree.
- Postgres store, outbox and daily anchor publication: M1 and the infrastructure slice. Until then, deployed services refuse to start.

## Alternatives considered

- Managed ledger databases (QLDB-style): not portable to Kenya/Rwanda hosting (spec 17.3). Rejected.
- Merkle trees: better for partial proofs; unnecessary for v1. Rejected for now.

## Dependencies

None added (`node:crypto` only).
