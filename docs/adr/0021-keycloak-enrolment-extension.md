# ADR-0021: Patient enrolment and the Keycloak enrolment extension (first passkey)

- Status: accepted design (revised after an independent Codex design review: 17 findings, 4 critical); implementation in slices below
- Date: 2026-11-09
- Requirements/Risks: REQ-001; spec 2, 2.6, 8.4, 10.1, 11.4, 12, 13.1; ADR-0015, ADR-0017, ADR-0018, ADR-0019; RISK-S04, RISK-S05
- Product owner decisions (2026-11-09): points 2 and 3

## Context

ADR-0017 chose a narrow Keycloak extension for a patient's first passkey and in-person clinic confirmation. The first draft of this ADR asserted its safety properties without defining the protocol that enforces them. This version defines that protocol.

## Decisions

### 1. One owner: the identity service coordinates enrolment

The identity service is the enrolment coordinator, as ADR-0017 intended. It owns the enrolment transaction state machine (in the identity database, with its own audit outbox). The API owns the invitation and the clinical records and is called by the coordinator. Nothing else changes enrolment state.

### 2. What the clinician attests (product owner)

- An invitation authorises enrolment into one organisation; it does not identify the woman.
- At confirmation the clinician attests that she has identified the woman in front of her the way the clinic normally does (as at any appointment), and that the code was read from that woman's own phone.
- The portal records the attestation, the clinician and the time. No identity documents are stored.
- **Residual risks, documented:** a relayed screen or screenshot shown to the clinician, a malicious clinician, a coerced patient. The guarantee is "the woman the clinician identified enrolled on the phone she held", not more.

### 3. The code is typed by the clinician (product owner)

- The patient's phone shows a 6-digit code from a cryptographically secure generator.
- The clinician selects the invitation in the portal and types the code. The portal never lists pending codes.
- The code is a comparison aid, never a credential on its own. It is verified with a keyed HMAC (never a plain hash) within the selected invitation only. Collisions across invitations do not matter.
- Limits:
  - 5 wrong entries per invitation cancel its pending transactions;
  - at most 3 pending transactions per invitation;
  - rate limits per clinician, per organisation and per source;
  - each transaction lives 15 minutes.

### 4. Link, landing and the browser binding

- The link carries the invitation token in the URL **fragment** (never sent to servers or logs). The landing page posts it to the patient BFF and immediately removes it from the address bar (`history.replaceState`).
- Responses are `no-store` and `Referrer-Policy: no-referrer`. Opening the link (GET, link previews) never starts, consumes or confirms anything.
- An explicit "Start" (POST with Origin and CSRF checks) asks the coordinator to create a transaction bound to a new unpredictable browser secret.
- The BFF holds the secret in a `__Host-` cookie (Secure, HttpOnly, Path `/`, SameSite=Lax, 15 minutes). Every later step (status polling, continue, cancel) needs it. Several tabs and a replaced cookie are tested.

### 5. Authenticated handoff into Keycloak (no trust in request parameters)

- After the clinician confirms, the patient's browser chooses "Continue".
- The BFF checks the browser secret, creates its own OIDC transaction (ADR-0019 section 1 pattern), and asks the coordinator over the back channel for a **handoff**: a one-time, 5-minute grant bound to:
  - the enrolment transaction;
  - the issuer and realm;
  - the client `bff-patient` and its exact redirect URI;
  - the PKCE S256 challenge, `state` and `nonce`.
- The authorisation request carries only an opaque handoff reference. No invitation token, code or identity data goes into Keycloak's URL.
- The extension never trusts `client_request_param_*`. It redeems the reference with the coordinator, which compares the real request's client, redirect URI, PKCE challenge, state and nonce with the stored binding. The PKCE verifier never leaves the BFF.

### 6. Atomic, idempotent redemption bound to one Keycloak authentication session

- `confirmed → redeemed` happens atomically in the coordinator. It records Keycloak's full authentication-session identity: root session id, client UUID and tab id.
- An identical retry gets the same answer; any other session or a changed request is refused.
- Confirmation itself reserves the invitation for that one transaction, atomically, and cancels its competitors. A revocation or expiry is re-checked at redemption and at completion.
- Restarting Keycloak authentication never revives a used handoff.

### 7. Keycloak flow: a mandatory enrolment branch, no SSO reuse

- The patient browser flow gets a conditional branch that runs **before** the SSO-cookie step whenever the request carries a handoff reference for `bff-patient`.
- In that branch the extension:
  - redeems the handoff;
  - ignores and never reuses any existing authenticated user (a shared phone with an existing session cannot capture the new passkey);
  - creates, or on a bound retry resumes, exactly one provisional user with an opaque username.
- Ordinary patient sign-in stays a separate branch. ADR-0019's clinician flow is untouched.
- `check:realm` asserts this structure.

### 8. Guarded registration

- The stock `webauthn-register-passwordless` required action is **disabled**.
- The extension provides one action, `endo-enrolment-passkey`, built on the passwordless policy and credential type. It has `initiatedActionSupport() = NOT_SUPPORTED`, so `kc_action` cannot reach it, and is never a default.
- It checks the redeemed binding (transaction, session tuple, provisional user) both when generating the challenge and when processing the response, and refuses anything missing, cancelled, expired, completed or mismatched.
- Adding further passkeys and recovery for existing patients are designed separately (later). Until then there is deliberately no self-service way to add a passkey.

### 9. Email-free accounts, explicitly

- The realm declares a user profile with the opaque username only: no email, first name or last name. Identity data lives only in the identity vault.
- `VERIFY_PROFILE` and email-verification required actions are disabled.
- The provisional user is enabled only for the enrolment flow. The extension assigns the `patient` realm role explicitly at completion. No dummy email addresses are used.

### 10. Completion is a recoverable state machine, not one transaction

- Coordinator states:

  | State                   | Meaning                                                      |
  | ----------------------- | ------------------------------------------------------------ |
  | `awaiting-confirmation` | The patient pressed Start; waiting for the clinician         |
  | `confirmed`             | The clinician confirmed; the invitation is reserved          |
  | `redeemed`              | Keycloak redeemed the handoff for one authentication session |
  | `credential-committed`  | The passkey is durably stored in Keycloak                    |
  | `provisioning`          | Identity and clinical records are being created              |
  | `completed`             | Everything is in place                                       |

  The terminal failure states are `cancelled`, `expired` and `failed`.

- **Credential commitment** is reported by the extension from a Keycloak post-commit hook. If that report is lost, a reconciliation job asks Keycloak whether the provisional user has the credential. Provisioning never starts on an unsuccessful registration.
- **Stable ids are reserved before any remote call:** the person id and patient-record id are fixed in the transaction.
- **Every remote step is idempotent, keyed by the transaction:**
  - the identity service creates the person with the issuer and subject, and the patient link, through a new workload-authorised operation;
  - the API creates the patient record, **then** claims the invitation (the schema requires that order), and writes completion and its audit event in one clinical transaction.
- **Access is gated:** an account counts only when the coordinator says `completed`. The BFF refuses any other subject, and ordinary login refuses provisional users.

### 11. Provisional users: quarantine and cleanup

- Each transaction has exactly one provisional Keycloak user, correlated by an opaque attribute.
- If a transaction ends `cancelled`, `expired` or `failed`, a cleanup job removes the provisional user, its credentials and sessions, and any partial records. It removes them idempotently and fenced against a concurrent completion. It never removes an established user because of a timeout.
- Stalled transactions raise an alert.

### 12. Consent-pending session

- After completion the BFF creates a **consent-pending** session. It allows only reading and recording consent, signing out and cancelling.
- Recording `self_tracking` promotes the session to an ordinary patient session and rotates its id.
- Declining it, or leaving it undecided until expiry, cancels the enrolment: access is refused at once and cleanup removes the account (section 11).
- The four purposes are recorded independently with version and time (spec 13.1).
- Until she grants sharing, the clinician sees only "invitation accepted, sharing declined" (REQ-001).

### 13. Routes and callers (ADR-0018 workload tokens; mTLS underneath)

| Route (owner)                                 | Caller               | Authorisation                                                                         |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| start, status, continue, cancel (identity)    | patient BFF          | workload scope `identity.enrolment.patient`, plus the browser secret checked per call |
| confirm, revoke (identity, via API)           | clinic BFF → API     | clinician session (ADR-0019), current membership, the invitation's organisation       |
| redeem, credential-committed (identity)       | Keycloak extension   | workload scope `identity.enrolment.keycloak`                                          |
| create patient record, claim invitation (API) | identity coordinator | workload scope `api.enrolment.complete`                                               |

- Each scope belongs to one caller, and a valid token alone is never enough: every call is then checked against the transaction.

### 14. Audit

- **Events:** start, confirm (with clinician and organisation), wrong-code attempt, cancel, redeem, credential committed, provisioning steps, completion, consent decisions and cleanup.
- **How they are written:** transactionally in each owning store through its outbox. This closes ADR-0018's identity-service gap for enrolment.
- **What they never contain:** invitation tokens, codes, browser secrets or handoff references. Keycloak debug logging stays off.

### 15. Java build and supply chain

- **Pinning:** the exact JDK, Maven, plugins, parent POMs and dependency versions. No ranges, no snapshots, Maven Central only, with checksum verification.
- **Same rules as JavaScript:**
  - the 7-day rule and licence review for every Java dependency;
  - OSV-Scanner over the resolved Maven dependency tree;
  - Semgrep Java rules;
  - CodeQL for Java.
- **Image:** the JAR is built in a digest-pinned build container and baked into a custom Keycloak image with an SBOM, signed and verified like our other images (ADR-0016).
- **Ownership:** CODEOWNERS adds security review for Java sources and POMs.

### 16. Upgrades and acceptance

- The Keycloak image and the extension are pinned together.
- Keycloak's authentication interfaces are internal (`server-spi-private`), so every Keycloak upgrade must pass the real-Keycloak test suite before release.
- That suite covers:
  - existing patient or clinician SSO cookies;
  - a substituted handoff reference;
  - a lost cookie or callback;
  - a Keycloak restart mid-flow;
  - a cross-tab redemption;
  - concurrent confirmation;
  - a direct `kc_action`;
  - a crash at every completion boundary;
  - no WebAuthn support;
  - a revoked invitation;
  - consent refusal.

  It also includes ADR-0019 slice 7b.

- Realm changes on existing deployments go through a reviewed migration (imports skip existing realms, ADR-0015), with effective-configuration checks and a rollback plan.
- An external review of the authentication design is required before M1 exits (ADR-0017).

## Implementation slices

1. Coordinator state machine and transaction store in the identity service, with code HMAC, limits and outbox.
2. Patient BFF landing, start, status and continue, with the browser secret.
3. Clinician confirm in the clinic BFF and API, with attestation and audit.
4. Handoff and redemption, with the binding checks.
5. Java extension (authenticator, guarded action, post-commit hook), its build pipeline and realm changes.
6. Provisioning and completion, the reconciliation and cleanup jobs.
7. The consent-pending session.
8. Real-Keycloak and browser tests (including ADR-0019 7b).

## Consequences

- ADR-0015 (stock registration action disabled; user profile), ADR-0017 (identity service confirmed as coordinator; clinician-typed code), ADR-0018 (new scopes; identity outbox for enrolment) and ADR-0019 (none beyond 7b) are updated as each slice lands.
- Self-service extra passkeys, recovery and the email one-time code (Section 24 item 17) remain separate designs.
