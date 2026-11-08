# @endo/api

**Purpose:** core domain API (spec 8.2): episodes, check-ins, reviews, consent, audit. Internal only; reached from BFFs and jobs over mTLS with short-lived service tokens.

**Owners:** platform engineering; changes to `src/app.ts` hooks need security review.

## Public API (HTTP)

| Route                 | Policy             | Purpose                                                                                                                                  |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`        | public (liveness)  | Liveness                                                                                                                                 |
| `GET /v1/hello`       | `system.hello`     | M0 walking skeleton                                                                                                                      |
| `POST /v1/enrolments` | `enrolment.create` | REQ-001: a clinician creates a single-use invitation for their organisation; the link token is returned once and only its hash is stored |

## How every request is handled

1. `onRequest`: security headers; the route's `config.policy` is read. Routes without a valid policy cannot be registered (spec 2.5).
2. Service token verified (Ed25519, 60 s, `aud=api`, allowlisted issuer). Failure: audited as `denied`, then 401.
3. `can()` from `@endo/authz` with the current consent state. Decision audited **before** the handler runs; if the audit write fails the request fails (spec 2.6).
4. Errors are RFC 9457 problem details that never echo input (spec 9.1).

## Current state (M0)

- Audit store: PostgreSQL (`API_AUDIT_DATABASE_URL`, ADR-0013); required in staging and production, in-memory fallback in dev/test only. Run `pnpm --filter @endo/audit migrate` before starting.
- Consent loader returns no consents (fail closed) until the consent service lands (M1).
- `openapi.yaml` generation from Zod schemas starts with the first domain routes (M1).
