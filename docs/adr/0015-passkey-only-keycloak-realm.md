# ADR-0015: Passkey-only Keycloak realm, imported from a reviewed file

- Status: accepted
- Date: 2026-11-08
- Requirements/Risks: spec 3.1, 8.4, 10.1, 10.2, 12.2; RISK-S01, RISK-S02, RISK-S04

## Context

M0 needs a Keycloak dev realm (spec 20). Sign-in is by passkey for patients (10.1) and phishing-resistant MFA for clinicians and staff (10.2). Keycloak's usual "username, then WebAuthn" flow has a trap: when a user has no passkey yet, Keycloak offers to register one straight after the username step. Anyone who knows or guesses a username could then attach their own passkey to that account.

## Decision

1. **Realm as code, no new dependency.** `infra/modules/platform/realm/endo-dev.json` is mounted into Keycloak and imported with `--import-realm` (built into Keycloak). We considered the Keycloak OpenTofu provider and keycloak-config-cli, which would add a dependency and need their own review; the import file needs neither. Trade-off: the import skips an existing realm, so changes apply after a re-import (`infra/README.md`). This is acceptable for dev; shared and production environments will reconsider declarative sync.
2. **Usernameless passkey flow.** The browser flow is: existing session cookie, or a discoverable passkey with user verification (`webauthn-authenticator-passwordless`, resident key required, UV required). There is no username step, and the passwordless authenticator never offers credential setup, so no credential can be added during sign-in. Passkeys are attached only through enrolment links (M1), which use single-use action tokens.
3. **No passwords anywhere.** Self-registration, password reset, remember-me, `UPDATE_PASSWORD` and `CONFIGURE_TOTP` (TOTP is not phishing-resistant, spec 2 rule 7) are off.
4. **BFF clients only** (spec 8.4). `bff-patient` and `bff-clinician` are confidential clients with the authorisation code flow, PKCE S256, exact redirect URIs, no CORS origins, no password grant, no implicit flow, no offline tokens. Client secrets are generated per environment by OpenTofu and injected via environment placeholders; the file holds none. A later change may move to `private_key_jwt` with keys held in OpenBao.
5. **Sessions and tokens** follow spec 10: 30 min idle and 12 h absolute for the realm, 15 min idle for the clinician client; 5 min access tokens; refresh-token rotation.
6. **Keycloak defaults switched off.** The password grant, password reset, registration and first-broker-login flows are bound to a flow that always denies. The built-in `account`, `account-console`, `admin-cli` and `security-admin-console` clients are disabled in this realm (users change their details in our apps, where changes are audited; administrators use the master realm). The default role is empty, and each BFF client carries only its mapped roles (`fullScopeAllowed: false`; `bff-patient`: `patient`; `bff-clinician`: `clinician`, `org_admin`, `glucorp_support`; never `glucorp_platform_admin`). Keycloak still re-adds `offline_access` to the default role on import; it has no effect, because no client has the `offline_access` scope and that role is outside every client's scope mapping.
7. **Events.** Login and credential events are kept 30 days in the identity database. Admin event representations are off, and the default `jboss-logging` event listener is removed, because both can write usernames and email addresses outside the identity store (spec 2: no PII in logs).
8. **Adding a passkey needs fresh authentication** (`webauthn-register-passwordless` with `max_auth_age: 0`), so someone holding a recent session on a shared phone cannot attach their own authenticator.
9. **No identity brokering yet.** `identityProviders` is explicitly empty and first broker login is denied until the M1 design checks `amr`/`acr` and defines account linking.
10. **CI gate.** `tools/check-keycloak-realm.mjs` (`pnpm check:realm`) checks every flow in the file, rejects per-client flow overrides, unreviewed clients, extra scopes and mappers, and fails if any rule above is weakened. Each rule has its own negative test, which must be caught.

## Consequences

- Email one-time code fallback (10.1) is not in the realm yet: it needs either a Keycloak extension or a flow owned by the identity service. Decided in M1 (spec Section 24 item 17).
- Hospital identity-provider brokering (10.2) will add `identity-provider-redirector` and a post-broker flow that checks `amr`/`acr`; both need changes to this ADR and to the CI gate.
- Reviewed independently (Codex, read-only) before merge. That review found the stale-session passkey addition, the logging listener and the CI-gate gaps, all fixed here.
- Not yet verified end to end: a real passkey sign-in and the claims in the issued tokens. That needs a WebAuthn virtual authenticator in a browser test (M1).
- Verified on the local cluster: the realm imports; the built-in clients are disabled and the unused flows bound to the deny flow; the password grant is refused (`unauthorized_client`); a foreign redirect URI is refused; an authorisation request without PKCE is rejected (`Missing parameter: code_challenge_method`); client secrets resolve from the environment.
