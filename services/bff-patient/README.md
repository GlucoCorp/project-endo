# @endo/bff-patient

**Purpose:** backend-for-frontend for `apps/patient-web` (spec 8.2, 8.4). Holds sessions and service tokens server-side; the browser only ever has an `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` session cookie.

**Owners:** patient experience team; auth changes need security review.

## Public API (HTTP)

| Route           | Auth              | Purpose                                                  |
| --------------- | ----------------- | -------------------------------------------------------- |
| `GET /healthz`  | public (liveness) | Liveness                                                 |
| `GET /v1/hello` | session           | M0 walking skeleton: proves BFF -> API -> authz -> audit |

## Current state (M0)

- Sessions: `DevSessionStore` only, refused outside dev/test. Passkey and email-OTP sessions via Keycloak arrive in M1 (REQ-001).
- CSRF synchronizer tokens arrive with the first mutating route (M1).
- Service-to-service mTLS is added by the infrastructure slice; service tokens are used now.

## Run locally

See the root README. `ENDO_ENV=dev`, `BFF_PATIENT_DEV_SESSIONS_ENABLED=true`; the process prints one synthetic session cookie to stdout.
