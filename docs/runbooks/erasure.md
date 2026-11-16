# Erasure (account deletion)

REQ-009, ADR-0029, Section 24 item 38. Owner: platform on-call; the DPO reviews monthly.

## What happens automatically

1. She asks for deletion in the app (a recent sign-in is required). For 14 days she can keep her account.
2. The jobs process (`node services/api/src/jobs-main.ts`), hourly:
   - runs `patient_erase` for each due request: her per-patient key is destroyed first, then every clinical row of hers; the request row stays, without PHI;
   - asks the identity service to erase her (key shredded, sign-in subject cleared), then to purge her identity rows (person, patient links, email codes, enrolment records); `deletion_request.identity_erased_at` is set only when both succeed, and failures are retried every run.
3. Audit events name opaque ids only and stay (7 years).

## Operator step: her Keycloak account

Until the jobs process holds a narrowly scoped Keycloak credential, an operator removes her Keycloak user (and with it her passkey) weekly:

1. Take just-in-time access to the Keycloak admin console (`access-requests.md`).
2. List users with no linked person: the identity service exposes none of her data, so use the audit store's `identity.person.purged` events of the past week to get the person ids, and the realm's user attribute `endo_person_id` where set; otherwise the users the enrolment extension marked provisional and older than 24 hours.
3. Delete those users. Record the count (not names) in the weekly access review.

She cannot sign in to the app in the meantime: her identity can no longer be resolved.

## Checks

- Daily alert if any `deletion_request` is due for more than 24 hours without `erased_at`, or erased for more than 24 hours without `identity_erased_at` (the jobs log `deletion.run` with counts).
- Monthly: the DPO reviews counts of requests, cancellations and erasures.
- Restores replay erasures before serving traffic (`restore.md`).
