# @endo/api

**Purpose:** core domain API (spec 8.2): episodes, check-ins, reviews, consent, audit. Internal only; reached from BFFs and jobs over mTLS with short-lived service tokens.

**Owners:** platform engineering; changes to `src/app.ts` hooks need security review.

## Public API (HTTP)

| Route                                                                        | Policy                                         | Purpose                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                               | public (liveness)                              | Liveness                                                                                                                                                                                                                          |
| `GET /v1/hello`                                                              | `system.hello`                                 | M0 walking skeleton                                                                                                                                                                                                               |
| `POST /v1/enrolments`                                                        | `enrolment.create`                             | REQ-001: a clinician creates a single-use invitation for their organisation; the link token is returned once and only its hash is stored                                                                                          |
| `POST /internal/v1/memberships/resolve`                                      | workload `api.membership.resolve` (bff-clinic) | ADR-0019: a signed-in person's active memberships (organisation and role only), via the dedicated cross-organisation lookup                                                                                                       |
| `POST /internal/v1/enrolment/invitations/find`                               | workload `api.enrolment.coordinate` (identity) | ADR-0021: a live invitation (id, organisation, reserved) by the SHA-256 of its link token; one 404 for every link that is not live. Only with a clinical database                                                                 |
| `POST /internal/v1/enrolment/invitations/state`                              | workload `api.enrolment.coordinate` (identity) | ADR-0021: an invitation's state for the coordinator (missing, live, expired, revoked, claimed; the reserving transaction)                                                                                                         |
| `POST /internal/v1/enrolment/invitations/{reserve,release,revoke,claim}`     | workload `api.enrolment.coordinate` (identity) | ADR-0021 sections 6, 10 and 11: hold, release (fenced), revoke after a decline (only while this transaction holds it) and claim, each audited with the change                                                                     |
| `GET /v1/me/consents`                                                        | `consent.read_own` (patient)                   | Spec 13.1: her current decision and the current explanation version for each purpose                                                                                                                                              |
| `PUT /v1/me/consents/{purpose}`                                              | `consent.update_own` (patient)                 | Grant or withdraw a purpose on the current explanation version; effective immediately (authorisation reads current consent on every request); audited through the outbox; withdrawing `self_tracking` is account deletion instead |
| `GET /v1/me/deletion`, `POST /v1/me/deletion`, `POST /v1/me/deletion/cancel` | `own_data.delete` (patient)                    | REQ-009: her deletion request (14 days to change her mind; one open request), audited through the outbox                                                                                                                          |
| `POST /v1/me/export`                                                         | `own_data.export` (patient)                    | REQ-009: her complete record as a FHIR R4 Bundle, made on request, never stored or cached                                                                                                                                         |

Episodes, check-ins, reviews, history and sharing routes are described in their files under `src/routes/`.

## Jobs process (ADR-0029)

`node src/jobs-main.ts`: the same image, its own process and secrets. Hourly it erases patients whose deletion is due (`patient_erase`: her key first, then every row), then asks the identity service to erase her identity record with the jobs workload key, retrying until it succeeds. Logs carry counts only.

| Variable                        | Purpose                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `JOBS_CLINICAL_DATABASE_URL`    | Clinical store as a member of `endo_clinical_app`                                                |
| `JOBS_WORKLOAD_PRIVATE_KEY_JWK` | The jobs workload key (Ed25519); the identity service trusts it for `identity.person.erase` only |
| `JOBS_IDENTITY_BASE_URL`        | The identity service                                                                             |
| `JOBS_DELETION_INTERVAL_MS`     | Run interval (default one hour, at least one minute)                                             |

## How every request is handled

1. `onRequest`: security headers; the route's `config.policy` is read. Routes without a valid policy cannot be registered (spec 2.5).
2. Service token verified (Ed25519, 60 s, `aud=api`, allowlisted issuer). Failure: audited as `denied`, then 401.
3. `can()` from `@endo/authz` with the current consent state. Decision audited **before** the handler runs; if the audit write fails the request fails (spec 2.6).
4. Errors are RFC 9457 problem details that never echo input (spec 9.1).

## Current state (M0)

- Audit store: PostgreSQL (`API_AUDIT_DATABASE_URL`, ADR-0013); required in staging and production, in-memory fallback in dev/test only. Run `pnpm --filter @endo/audit migrate` before starting.
- Consent loader returns no consents (fail closed) until the consent service lands (M1).
- `openapi.yaml` generation from Zod schemas starts with the first domain routes (M1).
