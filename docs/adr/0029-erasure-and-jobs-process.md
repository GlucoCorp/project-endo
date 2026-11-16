# ADR-0029: Account deletion, crypto-shredding and the jobs process

- **Status:** accepted (decided under the product owner's delegation, 2026-11-15)
- **Requirements:** REQ-009; spec 2 (she can export and delete her data), 10.1, 11.4, 13.4; RISK-I06, RISK-I08

## Context

REQ-009 asks for account deletion with a 14-day grace period, then hard deletion from primary stores and immediate destruction of her per-patient key, with the audit entry kept without PHI, and a complete export. Clinical tables are append-only by trigger (consent, M2 tables, verdicts, decisions, checks, share links), and the API role has no DELETE grant. The identity service already crypto-shreds a person on `identity.person.erase`, a scope it trusts only for a `jobs` key.

## Decision

1. **Clinical migration 0014.** `deletion_request` (one open request per patient; `due_at` is set by the database to 14 days after the request and cannot be changed; the row has no foreign key, so it outlives her record as the record of the erasure, without PHI). `patient_erase(org, patient)` is `SECURITY DEFINER`, owned by the schema owner: it acts only on a due, uncancelled request, destroys her key first, then deletes every row of hers in dependency order and marks the request erased, in one transaction. The append-only trigger functions allow DELETE only when the current user owns the table, which happens only inside `patient_erase`; the API role still cannot delete anything directly.
2. **The jobs process.** `services/api/src/jobs-main.ts`: the same image as the API, a separate process with its own secrets (`JOBS_*`). Hourly it erases due requests, then calls the identity service's erasure route with the jobs workload key, retrying each run until it succeeds (404 counts as done). The API process never holds the jobs key. Erasure audit events go through the clinical outbox, which the API's relay publishes. Logs carry counts only.
3. **Export.** `POST /v1/me/export` builds a FHIR R4 Bundle on request (spec 5.3 mapping) and stores nothing (spec 11.4 allows 24 hours; we keep none). The human-readable copy is the treatments page printed on her device (no PDF library, so no new dependency). Shadow verdicts and identity data are left out (Section 24 item 36).
4. **Recent sign-in (spec 10.1).** Every sign-in asks for her passkey (`prompt=login`, `max_age=0`, `auth_time` checked) and makes a new session, so the patient BFF treats a session younger than 10 minutes as a recent sign-in. Export, asking for deletion and making a share link need it; reading and cancelling a deletion do not (Section 24 item 37).

## Alternatives

- Deleting from the API role with grants: rejected; any API bug could delete clinical history.
- Running the deletion job inside the API process: rejected; the API would hold the erase key for identity.
- Soft deletion with a flag: rejected; REQ-009 requires hard deletion.

## Consequences

- The identity step shreds her identity key and clears her sign-in subject, then purges her identity rows (identity migration 0009: person, patient links, email codes, enrolment records; the key tombstone stays). Her Keycloak user and passkey are removed by an operator (runbook) until the jobs process has a scoped Keycloak credential (Section 24 item 38).
- Backups keep her rows until they expire; the shredded key makes her goal text and notes unreadable there. A restore must replay `patient_key_shredded` and erased requests before serving (M6 runbook).
- A second deletion after a cancel is a new request with a new 14 days.
