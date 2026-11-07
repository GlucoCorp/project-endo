## What and why

<!-- One concern per PR (spec 0 rule 8). -->

## Traceability (spec 18.4)

- Requirements: REQ-
- Risks: RISK-

## Threat note (required if labelled `security-review`)

<!-- What could go wrong, and what prevents it. Required for auth, crypto, consent, audit, verdict, authz. -->

## Test evidence

<!-- Commands run and results. Screenshots for UI changes. -->

## Definition of done (spec 0)

- [ ] Requirement and risk IDs referenced
- [ ] Unit and integration tests added; changed-line coverage ≥ 90% for verdict, authz, consent; ≥ 80% elsewhere
- [ ] All CI checks pass, including security scans
- [ ] No new dependency without an ADR
- [ ] No PHI in logs, errors, analytics, URLs or test fixtures
- [ ] Accessibility checks pass for UI changes (axe, keyboard walkthrough)
- [ ] Docs, OpenAPI spec, threat model and data inventory updated if behaviour or schema changed
- [ ] Under 400 changed lines if touching auth, crypto, consent, audit or verdict (or agreed beforehand)
