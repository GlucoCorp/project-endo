# ADR-0017: Enrolment, first passkey and consent

- Status: accepted (design); clinical store implemented, remaining slices in M1
- Date: 2026-11-08
- Requirements/Risks: REQ-001; spec 3.2, 5.1, 5.2, 9.2, 10.1, 10.4, 13.1; RISK-S01, RISK-S04, RISK-I01, RISK-I03
- Decided by the product owner on 2026-11-08: points 2 and 3

## Context

REQ-001: a clinician creates a single-use enrolment link (7 days, organisation-bound, no PHI); the patient opens it, creates a passkey, then accepts or declines each consent purpose. Our Keycloak realm (ADR-0015) is passkey-only and usernameless, with registration, passwords and the password grant denied. Many patients have no email address.

Codex researched Keycloak 26.8.1 (documentation and tagged source) independently:

- No admin endpoint returns an action link without sending email (`execute-actions-email` requires an address).
- Keycloak Organizations invitations need email and self-registration.
- Token exchange or impersonation does not register a passkey, and adds a privileged client.
- An identity-service-owned WebAuthn implementation is viable but makes us responsible for all patient authentication and departs from the specified identity provider.
- A link or QR code is a bearer secret. Signing it stops tampering, not forwarding, and a new passkey proves control of a device, not who the person is.

## Decision

1. **Clinical store first** (`packages/clinical-store`, this ADR's first slice). It covers organisations, clinicians, pseudonymous patient records, enrolment invitations and consent decisions, with defence in depth in the database:
   - row-level security on `app.org_id` for every table, set per transaction by `withOrg`;
   - an API role that cannot delete rows, rewrite consent, set times or ordering, or re-open an invitation;
   - forward-only invitations (live → claimed or live → revoked), at most 7 days, with the issue time set by the database;
   - append-only consent, ordered by a database sequence assigned under a per-patient, per-purpose lock, with one `consent_current` view;
   - one cross-organisation lookup function, owned by a no-login role with read access to invitation columns only, and a pinned `search_path`;
   - roles created by bootstrap or infrastructure, never by migrations.
2. **First passkey through a small Keycloak extension** (product owner's choice). It is one provider JAR with an enrolment authenticator and a guarded passwordless-registration required action. The identity service owns invitation state and approves exactly one Keycloak authentication session over the back channel, with a short-lived, single-use assertion. Keycloak still generates, verifies and stores the passkey. Then a normal authorisation-code flow with PKCE signs her in to the BFF. Unrestricted registration through `kc_action` is disabled in favour of the guarded action. This is the repository's first non-TypeScript code: a documented, narrow exception to spec 8.1. Keycloak upgrades must re-run its integration tests.
3. **Clinic confirms in person** (product owner's choice). She scans the QR code in the clinic on her own phone. A short transaction code appears on her screen and on the clinician's, and the clinician confirms it. Only that confirmed transaction can register the first passkey. Opening the link does not consume it (link previews and scanners open links); confirmation binds it to one transaction, and creating the passkey consumes it.
4. **Email one-time code** (spec 10.1, Section 24 item 17) lives in the identity service: 6 digits, 10 minutes, rate and attempt limits, single use, bound to one transaction. The same back-channel handoff signs the patient in. It never authenticates clinicians or staff, and a patient-only session must never satisfy clinician sign-in.
5. **Provisional until consent.** Declining `self_tracking` removes the provisional account and credential. Declining `share_with_care_team` keeps her account, and the clinician sees only "invitation accepted, sharing declined".

## Consequences

- Remote enrolment is not supported in M1. A separate activation code can be added later if needed.
- New building blocks for the next slices:
  - `services/identity` with the identity vault (spec 5.2);
  - API routes `POST /v1/enrolments`, `POST /v1/enrolments/{id}/approve` and `POST /v1/enrolments/{id}/accept`. The spec's `{token}` accept route is refined to an id bound to the authenticated session, so the secret never travels in a path;
  - the Keycloak provider JAR, built in CI;
  - BFF sign-in with Keycloak;
  - patient-web enrolment and consent screens.
- ADR-0015's statement that passkeys are added "only through enrolment links" becomes enforceable only with point 2. Until then, an already signed-in user with a fresh passkey sign-in can add another passkey through `kc_action`.
- Spec 12.11 requires an external review of the authentication design before M1 exits. This ADR and the extension are its subject.
