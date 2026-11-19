# Requirements register

Requirement IDs are stable and never renumbered (spec 4, 18.4). Source of truth for wording: `PROJECT_ENDO_BUILD_SPEC.md` Section 4. This register tracks status and traceability.

| ID      | Title                     | Milestone | Status                                                                                             | Verified by                                                                                                                                                                 |
| ------- | ------------------------- | --------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-001 | Patient enrolment         | M1        | not started                                                                                        |                                                                                                                                                                             |
| REQ-002 | Start a treatment episode | M2        | built (catalogue and goals await clinical content)                                                 | `packages/clinical-store/src/episodes.integration.test.ts`, `services/api/src/episodes.test.ts`, `apps/patient-web/e2e/checkin.spec.ts`                                     |
| REQ-003 | Weekly check-in           | M2        | built, with push reminders; usability test (30 s) and approved wording outstanding                 | `packages/config/src/clinical-content.test.ts`, `services/api/src/episodes.test.ts`, `apps/patient-web/src/checkin/checkin.test.ts`, `apps/patient-web/e2e/checkin.spec.ts` |
| REQ-004 | Verdict generation        | M3        | engine, signing, shadow generation built; rule set and golden expectations await clinical sign-off | `packages/verdict/src/verdict.test.ts`, `services/api/src/verdicts.test.ts`, `packages/config/src/config.test.ts`                                                           |
| REQ-005 | Clinician review          | M4        | not started                                                                                        |                                                                                                                                                                             |
| REQ-006 | Pre-surgery check         | M4        | not started                                                                                        |                                                                                                                                                                             |
| REQ-007 | Red-flag handling         | M2        | built; care-team notification (M4) and approved list outstanding                                   | `services/api/src/episodes.test.ts`, `apps/patient-web/e2e/checkin.spec.ts`                                                                                                 |
| REQ-008 | Patient treatment history | M4        | not started                                                                                        |                                                                                                                                                                             |
| REQ-009 | Data rights               | M5        | crypto-shredding primitive built                                                                   | `packages/crypto/src/crypto.test.ts` (`REQ-009 crypto-shredding`)                                                                                                           |
| REQ-010 | Organisation admin        | M5        | authz policy only                                                                                  | `packages/authz/src/matrix.test.ts`                                                                                                                                         |
| REQ-011 | Aggregate dashboard       | M5        | authz policy only                                                                                  | `packages/authz/src/matrix.test.ts`                                                                                                                                         |

## Platform requirements from spec Section 2 (non-negotiables)

| Spec | Requirement                                 | Status                                               | Verified by                                          |
| ---- | ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| 2.3  | No PHI in logs, errors, URLs                | built for M0 surfaces                                | service-kit, api, bff tests (`SYNTHETIC_PHI_MARKER`) |
| 2.5  | Deny by default; route without policy fails | built                                                | api/bff route-declaration tests                      |
| 2.6  | Every health-data access audited            | built for M0 route (decision audited before handler) | `services/api/src/app.test.ts`                       |
| 2.8  | No long-lived secrets in code or CI         | CI uses no secrets; OIDC with infra slice            | workflows                                            |
| 2.9  | Clinical logic is signed-off configuration  | release gate built                                   | config tests                                         |

The traceability matrix generator (spec 18.4) is planned with the release pipeline.
