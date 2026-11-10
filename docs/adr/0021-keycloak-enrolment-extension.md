# ADR-0021: Patient enrolment and the Keycloak enrolment extension (first passkey)

- Status: accepted design (revised twice after independent Codex design reviews); implementation in slices below
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
- The code is a comparison aid, never a credential on its own. It is verified with a keyed HMAC (never a plain hash) within the selected invitation only. Codes of the (at most 3) pending transactions of one invitation are distinct.
- Limits:
  - wrong entries are counted per **invitation**, shared by all its transactions and all clinicians; the fifth cancels its pending transactions and locks the invitation for 15 minutes (audited);
  - rate limits per clinician, per organisation and per source;
  - each transaction lives 15 minutes.
- **Built (identity migration 0004, `confirmByCode`):** the database owns the counter and the lock. It counts one wrong entry at a time, turns the fifth into a 15-minute lock by its own clock, refuses starts and confirmations while locked, and refuses a lock that leaves a transaction awaiting confirmation. Each change has its own audit event. Confirmation happens only through the code check (the store refuses a bare `confirm`). The candidates are the selected invitation's live transactions of the clinician's organisation, and every candidate is compared. Starts, confirmations and code checks serialise on the invitation's guard row. The per-clinician, per-organisation and per-source rate limits belong to the clinic BFF and API (slice 3). Whether the counter ever resets other than by a lock is spec Section 24 item 20. **Residual risk (accepted, independent review 2026-11-10):** the database cannot tell a confirmation made after a real code match from one written directly by the service role, because checking a code needs the `kms/identity` key and the database deliberately never holds it (with it, anyone holding a database copy could try all 10^6 codes). So "only through the code check" is enforced in the service, not in the database. Whoever can run SQL as `endo_identity_app` can also run the service's own check. Mitigations: only the identity service's own login role (`identity_api`) holds `endo_identity_app` (no other service has credentials for this database), every confirmation is audited with its clinician and attestation, and the reservation in the clinical store (section 6) is still required before anything permanent happens.
- A code is never shown again after the transaction leaves `awaiting-confirmation`. "Start" repeated from the same browser binding returns the same transaction (idempotent), not a new code.

### 4. Link, landing and the browser binding

- The link carries the invitation token in the URL **fragment** (never sent to servers or logs). The landing page posts it to the patient BFF and immediately removes it from the address bar (`history.replaceState`).
- Responses are `no-store` and `Referrer-Policy: no-referrer`. Opening the link (GET, link previews) never starts, consumes or confirms anything.
- An explicit "Start" (POST with Origin and CSRF checks) asks the coordinator to create a transaction bound to a new unpredictable browser secret.
- The BFF holds the secret in a `__Host-` cookie (Secure, HttpOnly, Path `/`, SameSite=Lax) that expires exactly at the transaction's absolute deadline: 60 minutes after Start (section 10). It is never renewed. The coordinator enforces every deadline server-side, so the cookie lifetime grants nothing by itself. Once she reaches `consent-pending`, her consent-pending BFF session (section 12) carries her instead, so activation never depends on the cookie.
- Every later step (status polling, continue, resume, cancel) needs it. Several tabs and a replaced cookie are tested.

### 5. Authenticated handoff into Keycloak (no trust in request parameters)

- After the clinician confirms, the patient's browser chooses "Continue".
- The BFF checks the browser secret, creates its own OIDC transaction (ADR-0019 section 1 pattern), and asks the coordinator over the back channel for a **handoff**: a one-time, 5-minute grant bound to:
  - the enrolment transaction;
  - the issuer and realm;
  - the client `bff-patient` and its exact redirect URI;
  - the PKCE S256 challenge, `state` and `nonce`.
- The authorisation request carries only an opaque handoff reference. No invitation token, code or identity data goes into Keycloak's URL.
- The extension never trusts `client_request_param_*`. It redeems the reference with the coordinator, which compares the real request's client, redirect URI, PKCE challenge, state and nonce with the stored binding. The PKCE verifier never leaves the BFF.

### 6. The invitation reservation: one serialisation point

- The authoritative record is the **invitation row in the clinical store** (API). Migration 0005 adds `reserved_by` (transaction id) and `reserved_at`.
- Every invitation mutation is one conditional update on that row:
  - **reserve:** live, unreserved, or already reserved by the same transaction;
  - **revoke:** sets `revoked_at` whether or not it is reserved;
  - **release:** clears this transaction's reservation if the invitation is not final, and records a permanent fence for the transaction, so a delayed reserve or claim (even one that arrives after the release) never succeeds; it never touches another transaction's reservation;
  - **claim:** live, `reserved_by` equal to the transaction, not revoked. It creates the pseudonymous patient record in the same database transaction. Its identity reference is the identity-vault person id that the coordinator generates before claiming and uses in activation step 1.
- **Races:**
  - confirmation before revocation: the reservation stands, but a later revocation still wins, because the claim requires "not revoked";
  - revocation before claim: the claim fails, and the coordinator cancels the transaction and cleans up;
  - claim before revocation: the revocation is refused, because the invitation is final.

  All four operations are idempotent per transaction. Each locks the row, decides from its current state and makes at most one update, so the row itself is the durable record of the result. The database trigger also refuses a claim without a reservation, or a reservation passed directly from one transaction to another. An unknown outcome is resolved by asking the API for the invitation's state.

- New starts on a reserved invitation are refused. Starts are served only while the invitation is live and unreserved.
- Redemption into Keycloak is `confirmed → redeemed`, atomic in the coordinator. It records Keycloak's full authentication-session identity (root session id, client UUID, tab id). An identical retry gets the same answer; another session or a changed request is refused. A Keycloak restart never revives a used handoff.

### 7. Keycloak flow: an explicit tree, enrolment first, no SSO reuse

The patient browser flow is exactly this tree; `check:realm` asserts it:

```
endo patient browser (top level)
  1. endo-enrolment           ALTERNATIVE   (extension authenticator)
  2. auth-cookie              ALTERNATIVE
  3. webauthn-passwordless    ALTERNATIVE
```

- With no handoff reference, `endo-enrolment` answers `attempted()`, so Keycloak goes on to the ordinary alternatives. There is no `CONDITIONAL` execution: Keycloak 26.8 clears sibling alternatives before evaluating a condition.
- With a reference, it either succeeds or ends the flow. An invalid, expired or mismatched reference fails closed with a terminal error page (`failureChallenge`), not a plain `failure()`. Keycloak can let a plain failure of an alternative fall through to the next one, and it must never fall through to the SSO cookie.
- On success it ignores any existing authenticated user. It creates, or on a bound retry resumes, exactly one provisional user with an opaque username and the attribute `endo_enrolment=<transaction id>`.
- A **resume** reference (section 11) authenticates only that same provisional user, with the passkey she has just registered.
- Ordinary login (alternatives 2 and 3) refuses users who carry `endo_enrolment`, enforced by the extension's user-storage guard. Until activation (section 10), a provisional user cannot sign in any other way.

### 8. Guarded registration

- The stock `webauthn-register-passwordless` required action is **disabled**.
- The extension provides one action, `endo-enrolment-passkey`, built on the passwordless policy and credential type. It has `initiatedActionSupport() = NOT_SUPPORTED`, so `kc_action` cannot reach it, and is never a default.
- It checks the redeemed binding (transaction, session tuple, provisional user) both when generating the challenge and when processing the response, and refuses anything missing, cancelled, expired, completed or mismatched.
- Adding further passkeys and recovery for existing patients are designed separately (later). Until then there is deliberately no self-service way to add a passkey.

### 9. Email-free accounts, explicitly

- The realm declares a user profile with the opaque username only: no email, first name or last name. Identity data lives only in the identity vault.
- `VERIFY_PROFILE` and email-verification required actions are disabled.
- The provisional user is enabled only for the enrolment flow. The extension assigns the `patient` realm role explicitly at completion. No dummy email addresses are used.

### 10. Lifecycle: nothing permanent before consent

The coordinator's transition table (identity database). Each state before `claiming` ends at its own deadline or at the transaction's **absolute deadline, 60 minutes after Start**, whichever comes first. `claiming` and `activating` have no deadline, because they follow her consent and are resolved against the clinical store.

| From                        | Event                                                                             | To                                             | Side effects (idempotent, keyed by the transaction)                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none                        | patient presses Start (browser secret)                                            | `awaiting-confirmation`                        | code generated; invitation must be live and unreserved; 15 min                                                                                                                                                                                                                                                                                                 |
| `awaiting-confirmation`     | clinician confirms (correct code, attestation)                                    | `confirmed`                                    | API `reserve` (section 6); siblings cancelled; 15 min                                                                                                                                                                                                                                                                                                          |
| `confirmed`                 | Keycloak redeems the handoff                                                      | `redeemed`                                     | session tuple recorded; provisional user created; 15 min                                                                                                                                                                                                                                                                                                       |
| `redeemed`                  | extension post-commit hook, or reconciliation finds the credential                | `credential-committed`                         | none; 30 min to consent                                                                                                                                                                                                                                                                                                                                        |
| `redeemed`                  | BFF callback arrives before the commit notice                                     | `credential-committed`, then `consent-pending` | the coordinator reconciles at once by asking Keycloak whether the provisional user has the credential; if not, the callback is refused and the page offers "Continue" (resume)                                                                                                                                                                                 |
| `credential-committed`      | BFF callback with the expected subject                                            | `consent-pending`                              | consent-pending BFF session (section 12)                                                                                                                                                                                                                                                                                                                       |
| `consent-pending`           | she records `self_tracking: granted` (all four decisions held in the transaction) | `claiming`                                     | none yet                                                                                                                                                                                                                                                                                                                                                       |
| `claiming`                  | API `claim` succeeds (durably recorded)                                           | `activating`                                   | patient record created and invitation claimed, in one clinical transaction                                                                                                                                                                                                                                                                                     |
| `claiming`                  | API `claim` is definitely refused (invitation revoked or expired)                 | `cancelling`                                   | access refused at once                                                                                                                                                                                                                                                                                                                                         |
| `claiming`                  | outcome unknown (timeout, lost response)                                          | `claiming`                                     | retried; the coordinator asks the API for the invitation's state before deciding                                                                                                                                                                                                                                                                               |
| `claiming`                  | patient cancels, clinician revokes, or the claim stalls                           | `claiming` (cancel requested)                  | the coordinator asks the API to revoke or release the reservation; that conditional update and the claim serialise on the invitation row (section 6). If the claim already succeeded, the request is refused and the transaction goes to `activating`. Otherwise the reservation is gone, no later claim can succeed, and the transaction goes to `cancelling` |
| `activating`                | coordinator runs the activation steps in order                                    | `active`                                       | see below                                                                                                                                                                                                                                                                                                                                                      |
| any state before `claiming` | deadline passes, patient cancels, clinician revokes, `self_tracking` declined     | `cancelling`                                   | access refused at once                                                                                                                                                                                                                                                                                                                                         |
| `cancelling`                | cleanup completes                                                                 | `cancelled`                                    | see section 11                                                                                                                                                                                                                                                                                                                                                 |

- **`claiming` is the last point where enrolment can still be cancelled.** Its only remote step is the API `claim`, which creates the patient record and claims the reserved invitation in one clinical transaction. A definite refusal cancels. An unknown outcome is resolved by asking the API, never by guessing. A cancellation, revocation or stall during `claiming` never starts cleanup directly. Cleanup starts only once the clinical store has definitively established that the claim did not and cannot succeed, because the reservation is revoked or released. If the claim won, activation proceeds and she is told that leaving now means account deletion (REQ-009).
- **Activation is forward-only once the claim has succeeded.** These steps are each idempotent and durably recorded before the next:
  1. identity: create the person with the issuer and subject, plus the patient link;
  2. API: write all four consent decisions with their versions and times, and their audit events;
  3. Keycloak finalisation through the extension's narrow endpoint: assign `patient`, remove the `endo_enrolment` quarantine, durably acknowledged.

  A failed step is retried with backoff and alerts if it stalls. The transaction stays `activating`, and access stays consent-pending, until all three succeed. Nothing in it can be refused by a revocation, because the invitation is already claimed.

- **No clinical or identity records exist before `claiming` succeeds.** Consent decisions are held only in the transaction until then.

### 11. Cancellation and cleanup (per resource)

- **Before the claim succeeds:** cleanup deletes the provisional Keycloak user (and its credential and sessions) through the extension endpoint, releases or revokes the invitation, and wipes the code verifier and browser secret.
  - The invitation is revoked when she declined or the clinician revoked it.
  - It is released (reservation cleared) when she cancelled or the deadline passed, so the clinic can use it again.
- **Once `claiming` has succeeded,** cancellation is no longer possible. Activation only moves forward. A woman who changes her mind uses account deletion (REQ-009), which has its own retention rules.
- Cleanup is fenced: it runs only in `cancelling`, and activation steps check the state before writing. A remote write that finishes after cancellation is undone by the same cleanup, which is idempotent.
- **Lost callback:** if the OIDC callback never reaches the BFF after `credential-committed`, the patient's page (browser secret still valid) offers "Continue" until the 30-minute consent deadline. That starts a **resume** handoff bound to the same transaction (section 7), and she authenticates with her new passkey. After the deadline, cleanup runs.
- Stalled transactions raise an alert.

### 12. Consent-pending session

- The BFF accepts the callback only if the ID token passes ADR-0019-style validation (signature, issuer, audience, nonce, `acr`, freshness) **and** its subject equals the transaction's provisional subject.
- It then creates a **consent-pending** session that allows only: reading the explanations, recording each decision (into the transaction), signing out and cancelling.
- When the transaction reaches `active`, the session rotates into an ordinary patient session.
- Declining `self_tracking` moves the transaction to `cancelling` at once.
- The clinician sees only "invitation accepted, sharing declined" until she grants sharing (REQ-001).

### 13. Routes and callers (ADR-0018 workload tokens; mTLS underneath)

| Route (owner)                                                   | Caller               | Authorisation                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start, status, continue, resume, cancel, consent (identity)     | patient BFF          | workload scope `identity.enrolment.patient` + the browser secret checked per call                                                                                                      |
| confirm, revoke (identity)                                      | API                  | workload scope `identity.enrolment.clinic` (API only); the API first checks the clinician's session, current membership and the invitation's organisation, then passes the attestation |
| redeem, resume, credential-committed (identity)                 | Keycloak extension   | workload scope `identity.enrolment.keycloak`                                                                                                                                           |
| reserve, revoke, claim, state (API)                             | identity coordinator | workload scope `api.enrolment.coordinate`                                                                                                                                              |
| finalise, delete provisional user (Keycloak extension endpoint) | identity coordinator | workload scope `keycloak.enrolment.admin`; acts only on users carrying `endo_enrolment`                                                                                                |

Each scope belongs to one caller, and a valid token alone is never enough: every call is then checked against the transaction.

### 14. Audit

- Every transition in section 10 is written with its audit event, transactionally, in the owning store's outbox, correlated by transaction id. That includes start, confirm (clinician, organisation, attestation), wrong code, lock, reserve, revoke, redeem, credential committed, each activation step, consent decisions, cancellation, each cleanup step and expiry.
- The relays alert on stalled delivery.
- Events never contain invitation tokens, codes, browser secrets or handoff references. Keycloak debug logging stays off.

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
  - both browser-flow paths, with and without a handoff reference (section 7);
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

  It also includes the real-Keycloak clinician sign-in test deferred from ADR-0019 (ADR-0020).

- The handoff reference travels in the authorisation URL. Ingress, proxy and Keycloak access logs must not record query strings for these paths, and the reference is short-lived and single-use.
- Realm changes on existing deployments go through a reviewed migration (imports skip existing realms, ADR-0015), with effective-configuration checks and a rollback plan.
- An external review of the authentication design is required before M1 exits (ADR-0017).

## Implementation slices

1. Coordinator state machine and transaction store in the identity service (section 10 table), with code HMAC, shared attempt counter, limits and outbox; clinical migration 0005 for the invitation reservation (section 6).
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
