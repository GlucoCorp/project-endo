# ADR-0030: Integration service and SMART Backend Services

- **Status:** accepted (decided under the product owner's delegation, 2026-11-16)
- **Requirements:** spec 9.3, 16.1 to 16.4; RISK-E02

## Context

Record systems need read access to a consenting patient's treatment record (spec 9.3), authenticated per organisation with asymmetric client credentials, least scopes and an admin kill switch (spec 16.3). Integrations must fail closed and never block the hospital's own systems (spec 2).

## Decision

1. **A separate service, `services/integration`, with no database.** It exposes `/fhir/r4/` (read and search by patient for Patient, CarePlan, Goal, QuestionnaireResponse, Observation, Consent), `metadata` and `/.well-known/smart-configuration`. Every read goes to the API over a workload route (`api.fhir.read`) with this service's own key; the API checks the client is active and of that organisation, that the patient is of that organisation and currently shares with the care team, builds the Bundle (the same mapping as her export, without clinicians' notes or her access log) and audits the read against her record, so it appears in her access log.
2. **SMART Backend Services:** `client_credentials` with `private_key_jwt` (ES384 or RS384; the client's public JWK Set is registered by the organisation admin; private keys never reach us). Assertions: iss = sub = client_id, aud = our token endpoint, at most 5 minutes, each jti once. Access tokens are opaque, 5 minutes, scoped to what was asked and registered.
3. **Kill switch:** `integration_client.active` (clinical migration 0017), toggled by the organisation admin; the integration service re-resolves the client on every request, so off takes effect at once.
4. **Search is by patient only.** There is no open-ended listing across patients. Observations return an empty set while verdicts run in shadow mode (ADR-0028).
5. **No new dependency:** `jose` (already used by the API and BFFs) verifies assertions; form bodies are parsed with `URLSearchParams`.

## Alternatives

- Exposing FHIR from the API directly: rejected; the external boundary stays in its own process with its own key and scopes.
- A FHIR server product (HAPI, Medplum): rejected for now; a new runtime and data copy for a read-only facade.

## Consequences

- Access tokens and assertion ids are held in memory: one instance until a shared store exists (Section 24 item 41).
- Patient ids in FHIR URLs are our pseudonymous ids (spec 5.3); record systems map them through the explicit link made at SMART launch (M7b).
- Inferno conformance runs once the Inferno test kit is approved as a CI dependency (M7c).
- Outbound writes (verdict Observations, PDF DocumentReferences, spec 16.4) wait until verdicts leave shadow mode.
