# Erasure (account deletion)

REQ-009, ADR-0029, Section 24 item 38. Owner: platform on-call; the DPO reviews monthly.

## What happens automatically

1. She asks for deletion in the app (a recent sign-in is required). For 14 days she can keep her account.
2. The jobs process (`node services/api/src/jobs-main.ts`), hourly:
   - runs `patient_erase` for each due request: her per-patient key is destroyed first, then every clinical row of hers; the request row stays, without PHI;
   - asks the identity service to erase her: it first removes her Keycloak account, passkeys and sessions (through the extension's `erase` route, scope `keycloak.user.erase`, patients only), then shreds her key and clears her sign-in subject;
   - then asks it to purge her identity rows (person, patient links, email codes, enrolment records); `deletion_request.identity_erased_at` is set only when both succeed, and failures are retried every run.
3. Audit events name opaque ids only and stay (7 years).

## If her Keycloak account cannot be removed

The identity service answers 503 and nothing is erased in identity until Keycloak confirms; the jobs process retries every hour, so the daily alert below fires after 24 hours. A 409 means the account holds a staff role: a person must look (staff accounts are never erased this way).

## Checks

- Daily alert if any `deletion_request` is due for more than 24 hours without `erased_at`, or erased for more than 24 hours without `identity_erased_at` (the jobs log `deletion.run` with counts).
- Monthly: the DPO reviews counts of requests, cancellations and erasures.
- Restores replay erasures before serving traffic (`restore.md`).
