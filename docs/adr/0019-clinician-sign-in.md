# ADR-0019: Clinician sign-in through the clinic BFF

- Status: accepted (revised after independent design review)
- Date: 2026-11-09
- Requirements/Risks: spec 3.1, 8.4, 10.2, 10.4, 12.3; REQ-001; RISK-S01, RISK-S03, RISK-I03, RISK-I05

## Context

Clinicians sign in to the standalone clinic portal with a passkey through Keycloak (ADR-0015). Three facts live in three places: Keycloak knows the sign-in subject, the identity vault maps it to a person, and the clinical store knows which organisations that person works for. Codex reviewed the first draft (read-only) and found eleven gaps; this version addresses each one.

## Decision

### 1. OIDC transaction bound to the browser

- `services/bff-clinic` is the confidential client `bff-clinician`: authorisation code with PKCE S256, `response_mode=query`, GET callback, exact redirect URI.
- **Login start** creates a server-side transaction with: an unpredictable transaction id (sent only in the `__Host-endo_clinic_oidc` cookie: Secure, HttpOnly, SameSite=Lax, 10 minutes), `state`, `nonce`, the PKCE verifier, the issuer, the client id and the redirect URI. `state` alone never finds a transaction.
- **Callback** requires both the cookie and a matching `state`, then consumes the transaction atomically, once. A missing cookie, an expired, replayed or mismatched transaction is refused with a generic error. Concurrent tabs each have their own transaction.

### 2. ID token validation

- Trusted issuer, discovery and JWKS URLs come from configuration, never from a token. Key refreshes are rate-limited.
- Required: `iss` equals the configured issuer; `aud` contains the client id, and any other audience is refused unless `azp` equals the client id; `exp`; `iat` within 5 minutes; `nbf` if present; non-empty `sub`; `nonce` equals the transaction nonce; `auth_time` within 5 minutes of the callback (fresh authentication). Algorithms RS256 or ES256 only. Clock skew is at most 30 seconds.

### 3. Clinician assurance

- The `bff-clinician` client gets its own browser-flow binding in Keycloak that requires a fresh passkey with user verification. It never accepts an SSO cookie established by a patient flow. The realm gate (`check:realm`) is extended to allow exactly this override.
- Before creating a session, the BFF requires the `acr` value that this flow sets (configured, exact match) and `auth_time` freshness. Patient email-code sign-in and hospital brokering (later) must not satisfy this check. Any change to it needs this ADR updated.

### 4. Identities: subject to person to memberships

- **Single issuer.** One realm per region and one configured issuer per deployment. The identity service checks the issuer in each resolve request against its configured issuer and stores only `sub`. If a deployment ever has several issuers, `(iss, sub)` must be stored instead.
- **Subject to person.** `POST /internal/v1/subjects/resolve` on the identity service, workload scope `identity.subject.resolve`, held by bff-clinic only. Erased people never resolve. There is no automatic account creation and no linking by email.
- **Person to memberships.** `POST /internal/v1/memberships/resolve` on the API, workload scope `api.membership.resolve`, held by bff-clinic only. It returns active memberships only: `{ org_id, role }` per membership, nothing else.
- The API gets a **workload route policy** (`kind: 'workload'`, one required scope) beside its user policies, verified by `WorkloadTokenVerifier`, audited before the handler, failing closed. Service tokens and workload tokens stay separate (`typ`).
- The membership lookup crosses organisations before one is chosen, so it uses a **dedicated database function**, like the invitation lookup (ADR-0017):
  - input: exact `identity_ref`; output: active memberships only;
  - owned by a no-login role with column-level read access to `clinician` only;
  - pinned `search_path`, execute-only grant to the API role.

  Tenant row-level security is unchanged.

- The BFF passes the subject from a validated callback and the person id from identity resolution, never from browser input. Browser-visible refusals are generic. This trust in bff-clinic (it may resolve any subject) is accepted and audited.

### 5. Session state machine

1. `pending-org`: created after a valid callback with **a fresh session id and CSRF token**. The transaction id is never promoted to a session. It allows only listing the candidate organisations, choosing one, and signing out. Candidates are stored server-side.
2. **Choose organisation**: the browser submits a candidate index. The BFF re-reads current membership through the API, derives the role, and only then **rotates the session id and CSRF token** into `active`. With exactly one membership this happens automatically.
3. `active`: API calls are allowed. Switching organisation is a CSRF-protected POST that rotates the session again; requests from a stale tab (old session id) fail.

- **Cookie:** `__Host-endo_clinic_session` (Secure, HttpOnly, SameSite=Strict, path `/`). The callback (cross-site GET) answers with a same-origin page that then completes into the Strict session, tested in a real browser.
- **Lifetimes:** 15 minutes idle (spec 10.2) and an absolute 12 hours (ADR-0015 realm setting; spec 10.2 states only the idle limit). Only user-initiated requests count as activity; a request marked as background polling does not extend the idle time. The absolute deadline never moves.
- **Expiry and revocation** are atomic in the session store. In-memory sessions are refused in staging and production; the durable store (infrastructure slice) must offer atomic compare-and-set expiry across replicas.

### 6. Following Keycloak's session

- The session stores `iss`, `sub` and Keycloak `sid`. Keycloak back-channel logout is configured for `bff-clinician` (logout URL registered in the realm and checked by `check:realm`).
- The BFF's logout receiver validates the logout token's signature, issuer, audience, `iat`, the logout event claim, and `sid` or `sub`. It refuses tokens containing a `nonce`, rejects replays by `jti`, and revokes every matching session. It is idempotent.
- **Local sign-out** (CSRF-protected POST) revokes locally first, then redirects to Keycloak's RP-initiated logout with `id_token_hint` and the registered post-logout URI.
- **Revalidation with the refresh token** (decided by the product owner on 2026-11-09, replacing the first draft's userinfo check, which could not outlive Keycloak's 5-minute access tokens):
  - at sign-in the BFF keeps Keycloak's refresh token in the session, sealed with its own data key (`EnvelopeSealer`), bound to the issuer and subject, never sent to the browser;
  - when a session is used more than 4 minutes after Keycloak last confirmed it, the BFF makes a refresh-token grant and stores the rotated refresh token;
  - only one refresh runs per session at a time, because Keycloak rotates refresh tokens and refuses reuse;
  - if Keycloak refuses the refresh (its session has ended), the portal session is revoked at once;
  - if Keycloak is unreachable, the request is refused (503) but the session is kept, so an outage does not sign everyone out.
- So a missed logout notification ends the portal session within about 4 minutes of use, or at the 15-minute idle limit.

### 7. API calls

- For each request the BFF mints a 60-second service token (issuer `bff-clinic`, its own key): `sub` is the person id, plus `role` and `org_id` from the session and `patient_id: null`.
- The API trusts `bff-clinic` only for `clinician` and `org_admin`, never `glucorp_support`, and re-checks membership on every request (ADR-0017).

### 8. CSRF

- State-changing requests are POSTs and need both an `Origin` equal to the configured portal origin (missing or `null` is refused) and the per-session CSRF token in a header.
- The token is delivered in the body of the same-origin, no-store session response (`GET /v1/session`, and again after every rotation), never in a cookie or URL. Cross-origin pages cannot read it: the BFF sends no CORS headers.
- Exceptions:
  - the OIDC callback, a GET authenticated by the bound transaction;
  - the back-channel logout receiver, a server-to-server POST authenticated by the signed logout token.

### 9. Scope and tests

- **Standalone portal only.** The embedded SMART on FHIR launch (spec 10.2: follows the record system's session) is a separate design.
- Tests:
  - unit tests against a local OIDC provider stub with generated keys;
  - a browser test of the cookie flow;
  - a real-Keycloak integration gate covering a patient SSO session not reaching the clinician flow, back-channel logout, and the claims;
  - negative tests for every refusal in sections 1–8.

## Implementation notes

- Slice 3 (realm): the `endo clinician passkey` flow has a fixed id so the client override can reference it. Verified against Keycloak 26.8.1 on 2026-11-09: the import keeps the id and binds `bff-clinician`'s browser flow to it, and the back-channel logout URL is set. Keycloak documents that a login completed by authenticating (not by an SSO cookie) yields `acr` "1"; the BFF will require exactly that plus `auth_time` freshness. Not yet observed here: that needs a real passkey sign-in, which the slice 7 Keycloak integration test covers.

## Consequences

- New internal routes: identity `subjects/resolve` and API `memberships/resolve`, each with a single workload scope held only by bff-clinic, plus a dedicated cross-organisation membership lookup function in the clinical store.
- The realm gains a clinician browser-flow override, an `acr` mapping and a back-channel logout URL for `bff-clinician`; the CI realm gate changes accordingly.
- Clinician provisioning (an org admin invites a clinician, who enrols a passkey) is a later M1 slice. Test clinicians are seeded until then.
- The work is split into small PRs:
  1. identity resolve route;
  2. API workload policy, membership lookup and resolve route;
  3. realm changes;
  4. BFF OIDC transaction and callback;
  5. sessions, organisation selection and CSRF;
  6. logout;
  7. browser and Keycloak integration tests.
