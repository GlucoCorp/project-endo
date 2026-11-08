# ADR-0007: Authorisation as pure policy functions

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 2.5, 3.2, 10.4; RISK-I03, RISK-E01

## Context

Spec 10.4: `packages/authz` exports pure functions `can(subject, action, resource, context) -> Allow | Deny(reason)`; the spec 3.2 matrix is a table-driven test; Postgres row-level security is a second layer.

## Decision

- `can()` is pure: no I/O, no clock. Callers load consent state and pass `now`.
- One action per row of the spec 3.2 matrix (`ACTIONS`), plus `system.hello` for the M0 walking skeleton.
- Deny by default: the final `switch` covers each action explicitly; unknown actions and inactive subjects are denied first.
- Deny reasons are machine codes (`authz.no_consent`, `authz.org_mismatch`, ...) that are safe to audit and return.
- `glucorp_platform_admin` is denied every application action; break-glass is infrastructure-level only (spec 3.1).
- Support access requires an approved ticket scoped to exactly one patient or one org, currently within its window, and no longer than 4 hours (spec 10.3).
- Interpretations of the spec, pending confirmation (spec Section 24 items 10, 11):
  - "Create treatment episode: consented patient" is implemented as requiring `share_with_care_team` (the most restrictive reading).
  - "Care-team relationship" is implemented as same-organisation membership, as written in the matrix.

## Consequences

- `src/matrix.test.ts` transcribes the spec table cell for cell, plus property tests: nothing outside the matrix is ever allowed; no cross-org access; withdrawing `share_with_care_team` removes clinician access to patient data.
- Row-level security (`app.org_id`) arrives with the first tables (M1).

## Alternatives considered

- Policy engines (OPA/Rego, Cedar, Casbin): extra runtime and language for a matrix this size; harder for clinical and security reviewers to read. Rejected for v1.

## Dependencies

None added.
