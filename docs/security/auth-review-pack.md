# External review of the authentication design (M1 exit)

**Status:** ready for an external reviewer. **Required by:** spec Section 22 (M1 exit criteria) and ADR-0017. **Reviewer:** someone who did not build it, with experience of OIDC, WebAuthn and Keycloak. **Not in scope:** penetration testing (M6) and clinical content.

This pack tells the reviewer what to read, in what order, and what we most want challenged. Everything it describes is on `main`; the code paths are given so claims can be checked rather than trusted.

## 1. What is being reviewed

| Area                                                                         | Design                        | Code                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient enrolment: invitation, in-clinic confirmation by code, first passkey | ADR-0017, ADR-0021            | `services/api/src/routes/enrolments.ts`, `services/identity/src/enrolment/`, `services/bff-patient/src/enrolment.ts`, `services/keycloak-extension/` |
| Consent before activation, consent-pending session                           | ADR-0017, ADR-0021 section 12 | `services/bff-patient/src/sessions.ts`, `services/api/src/routes/coordinator.ts`                                                                     |
| Returning patient sign-in (usernameless passkey)                             | ADR-0015, Section 24 item 22  | `services/bff-patient/src/sign-in.ts`, identity `/internal/v1/patients/resolve`                                                                      |
| Email one-time code fallback                                                 | ADR-0026                      | `services/identity/src/email/`, `services/keycloak-extension/.../EmailCodeAuthenticator.java`                                                        |
| App lock and sign-out on shared phones                                       | spec 10.1, 13.2; RISK-S02     | `services/bff-patient/src/session-routes.ts`, `apps/patient-web/src/home/`                                                                           |
| Clinician sign-in, organisation choice, back-channel logout                  | ADR-0019                      | `services/bff-clinic/src/app.ts`, `packages/oidc/src/oidc.ts`                                                                                        |
| Service-to-service trust (BFF service tokens, workload tokens)               | ADR-0006, ADR-0018            | `packages/service-kit/`, `services/identity/src/`                                                                                                    |
| Authorisation (deny by default, policy per route, matrix tests)              | ADR-0007                      | `packages/authz/src/policy.ts`, `packages/authz/src/matrix.test.ts`                                                                                  |
| Keycloak realm (passkey-only, reviewed import, negative checks)              | ADR-0015, ADR-0025            | `infra/modules/platform/realm/`, `tools/check-keycloak-realm.mjs`                                                                                    |

Threat model rows most relevant: RISK-S01 to S05, RISK-I03, RISK-I05, RISK-E01, RISK-E03, RISK-E04 (`docs/threat-model.md`).

## 2. Suggested reading order (about half a day)

1. Spec Sections 2, 10 and 12 (non-negotiables, identity, security engineering).
2. ADR-0017 and ADR-0021 (enrolment): the longest and riskiest flow.
3. ADR-0019 (clinician sign-in) and ADR-0018 (workload tokens).
4. ADR-0026 (email fallback) and ADR-0015 (realm).
5. The threat model rows listed above, then spot-check the code paths in section 1.

## 3. What we most want challenged

1. **Account takeover at enrolment (RISK-S04, S05).** A forwarded or photographed link, a second browser, two tabs, a replayed handoff reference, a Keycloak restart mid-flow. Is the in-clinic code plus browser binding enough? Is anything accepted that a person other than the patient in the clinic could complete?
2. **The Keycloak extension.** It uses Keycloak's internal (`server-spi-private`) interfaces. Is the guarded required action safe against a direct `kc_action` call, a crash between commit points and concurrent completion?
3. **Email fallback weakens passkey-only sign-in.** Codes are MAC-only, 10 minutes, single use, 5 attempts, 3 per address and 10 per IP per hour, sent only to a confirmed address, with an identical response for unknown addresses. Is offering it at all acceptable for this data, and are the limits right?
4. **Shared phones (RISK-S02).** App lock, 5-minute idle lock, unlock as a fresh passkey sign-in (`prompt=login`, `max_age=0`), sign-out ending the Keycloak session from the server. What remains reachable on a phone someone else picks up?
5. **Session handling.** `__Host-` cookies, SameSite Strict, exact-Origin checks on state changes, no tokens in the browser, fixation on every sign-in. Any route that changes state without these?
6. **Service trust.** Could a compromised patient BFF act as a clinician, or reach the identity service beyond its scopes (RISK-S03, I05)?
7. **Cross-organisation isolation (RISK-I03).** Policy checks plus row-level security as a second layer. Any path where the organisation comes from the request instead of the session?
8. **Logging (RISK-I02).** No PHI, tokens, codes or addresses in logs, errors or URLs. Tests push `SYNTHETIC_PHI_MARKER` through new surfaces; are there surfaces they miss?

## 4. Known gaps (do not report these as findings, but tell us if you rank them differently)

- Session and OIDC transaction stores are in memory (dev only, refused in staging and production); the durable store comes with the infrastructure slice.
- Real-Keycloak end-to-end tests (ADR-0021 slice 8) are not yet built; the extension has unit tests and the realm has negative configuration checks only.
- After an email-code sign-in she is not yet prompted to register a new passkey.
- No alerting yet for enrolment transactions stuck in activating or cancelling.
- Postfix for deployed mail is not yet configured (Mailpit in development).
- Remote enrolment is not supported in M1 (Section 24 item 18).

## 5. How to report

One finding per issue: title, affected component and file, a concrete scenario (inputs and state that lead to the harm), severity (critical, high, medium, low), and a suggested fix if you have one. Send to the product owner; findings are tracked as GitHub issues labelled `security-review`, and M1 exits when every critical and high finding is closed or has an accepted risk entry in `docs/risk/`.

## 6. Data the reviewer may see

Synthetic data only (spec 12.11). The reviewer needs read access to the repository and, if they want to run it, the local stack in `infra/dev/` and `infra/modules/platform/` with synthetic data. No production system, secret or log is shared.
