# @endo/bff-patient

**Purpose:** backend-for-frontend for `apps/patient-web` (spec 8.2, 8.4). Holds sessions and service tokens server-side; the browser only ever has an `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` session cookie.

**Owners:** patient experience team; auth changes need security review.

## Public API (HTTP)

| Route                       | Auth                          | Purpose                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`              | public (liveness)             | Liveness                                                                                                                                                                                                                                                                                                   |
| `GET /v1/hello`             | session                       | M0 walking skeleton: proves BFF -> API -> authz -> audit                                                                                                                                                                                                                                                   |
| `POST /v1/enrolment/start`  | enrolment (before an account) | ADR-0021: start enrolment with the link token (from the URL fragment, posted by the page). Sets `__Host-endo_enrolment` (Secure, HttpOnly, SameSite=Lax, expires at the transaction's absolute deadline). Returns the code once. Exact Origin and a JSON body required; 10 starts per client IP per minute |
| `GET /v1/enrolment/status`  | enrolment cookie              | Her transaction's state, never the code                                                                                                                                                                                                                                                                    |
| `POST /v1/enrolment/cancel` | enrolment cookie              | She cancels; clears the cookie. Exact Origin and a JSON body required                                                                                                                                                                                                                                      |

## Current state (M0)

- Sessions: `DevSessionStore` only, refused outside dev/test. Passkey and email-OTP sessions via Keycloak arrive in M1 (REQ-001).
- CSRF: the enrolment routes run before any session exists, so they require the exact patient Origin and a JSON body, which a cross-site page cannot send without a CORS preflight this service never allows. Session-bound synchronizer tokens arrive with the first mutating session route.
- Enrolment is configured by `BFF_PATIENT_IDENTITY_BASE_URL`, `BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK` and `BFF_PATIENT_ORIGIN` (all three, or none; without them the routes do not exist). Only SHA-256 hashes of the link token and the browser secret reach the identity service.
- Service-to-service mTLS is added by the infrastructure slice; service tokens are used now.

## Run locally

See the root README. `ENDO_ENV=dev`, `BFF_PATIENT_DEV_SESSIONS_ENABLED=true`; the process prints one synthetic session cookie to stdout.
