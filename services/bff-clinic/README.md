# @endo/bff-clinic

**Purpose:** backend-for-frontend for the standalone clinic portal (spec 8.2, 8.4, 10.2; ADR-0019). Clinicians sign in with a passkey through Keycloak; tokens never reach the browser, which holds only HttpOnly cookies.

**Owners:** security engineering (clinician authentication). Named human reviewer required.

## Public API (HTTP)

| Route                           | Access                                           | Purpose                                                                                                                                     |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                  | public (liveness)                                | Liveness                                                                                                                                    |
| `GET /auth/login`               | OIDC start                                       | New transaction bound to this browser (Lax cookie), then Keycloak with PKCE S256, state, nonce, fresh login                                 |
| `GET /auth/callback`            | OIDC callback                                    | Cookie and state must match one live transaction (consumed once); ID token validated; person and memberships resolved; fresh Strict session |
| `GET /v1/session`               | session (pending allowed)                        | Session state, organisations (by index) and the CSRF token (no identity data)                                                               |
| `POST /v1/session/organisation` | session (pending allowed), Origin and CSRF token | Choose or switch organisation by index; membership re-read, current role used, session id and CSRF token rotated                            |
| `GET /v1/context`               | session (active organisation)                    | Active organisation and role                                                                                                                |

## Rules

- Refusals are generic: a failed sign-in never says which check failed.
- Every Keycloak URL comes from configuration, never from a token or discovery at request time.
- Staging and production need the durable session store (infrastructure slice); until then the service refuses to start there.
- State-changing requests need the exact portal `Origin` and the session's CSRF token (`x-csrf-token`).
- A session waiting for an organisation may only see its state, choose, or sign out.
- Coming next (ADR-0019 slices 6-7): sign-out and back-channel logout, browser and real-Keycloak tests.
