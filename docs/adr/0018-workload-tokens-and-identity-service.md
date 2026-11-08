# ADR-0018: Workload tokens and the identity service

- Status: accepted
- Date: 2026-11-08
- Requirements/Risks: spec 2.4, 5.2, 8.2, 8.4, 11.2, 12.3; REQ-009; RISK-S03, RISK-I01, RISK-E01

## Context

The identity service (spec 5.2) must be the only component touching the identity database. Some calls to it are made on nobody's behalf: the API creating a person while a patient enrols, the jobs service erasing one after the grace period, and (next) the Keycloak extension during enrolment. Service tokens (ADR-0006) always carry an end-user subject and role, so they cannot express these calls.

## Decision

1. **Workload tokens** (`service-kit`): Ed25519, 60 seconds, audience-pinned, `typ: endo-workload+jwt`, `iss = sub =` the calling service, and a `scope` list. They cannot be used as service tokens or the other way round (different `typ`, tested).
2. **Per-caller keys and scope allowlists.** The verifier holds one public key per trusted service and the scopes that service may ever request. A token asking for any other scope is rejected. Callers request only the scopes the call needs.
3. **Identity service routes declare their access** (`public` liveness, or `workload` with one required scope). The service refuses to start otherwise. Every authenticated request is audited (actor `system`, purpose `operations`) before the handler runs, and an audit failure fails the request.
4. **First routes:** `POST /internal/v1/persons` (scope `identity.person.create`, API) and `POST /internal/v1/persons/{id}/erasure` (scope `identity.person.erase`, jobs). Identity fields are encrypted under each person's own key (`FieldCipher`, `kms/identity`, `PostgresPersonKeyStore`).
5. **Strict input.** Unknown request fields are rejected, not silently dropped (Fastify's default strips them); applied to the API as well (spec 12.3).

## Consequences

- Mutual TLS remains the transport layer (infra). Workload tokens are the application-layer check on top.
- Internal routes do not yet take an Idempotency-Key. Their callers (the API's enrolment flow, jobs) are idempotent today, and erasure is naturally idempotent. Person creation will become idempotent per enrolment transaction when the enrolment flow is wired (ADR-0017).
- Next: display and contact reads with purpose-bound authorisation, enrolment transactions and one-time codes (ADR-0017), and the Keycloak extension as a workload caller.
