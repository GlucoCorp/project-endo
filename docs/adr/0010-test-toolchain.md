# ADR-0010: Test toolchain and coverage gates

- Status: accepted (MPL-2.0 review below pending human confirmation)
- Date: 2026-11-07
- Requirements: spec 0 Definition of done, 19

## Context

Spec 19 names Vitest, Testcontainers, Playwright, axe-core and fast-check. The definition of done requires at least 90% coverage of changed lines for `packages/verdict`, `packages/authz` and `services/api/src/consent`, and 80% elsewhere.

## Decision

- **Vitest** for unit and integration tests; **@vitest/coverage-v8** for coverage; **fast-check** for property tests.
- Coverage thresholds per package in `vitest.config.ts`: 90% for `authz`, `audit`, `crypto`, `service-kit` (security-critical; stricter than the spec minimum), 80% elsewhere. Process entrypoints (`src/main.ts`) are excluded and covered by the smoke run.
- Tests name the requirement or risk they verify (`describe('REQ-004 RISK-C01 ...')`, spec 18.4).
- Synthetic PHI markers (`SYNTHETIC_PHI_MARKER`) are pushed through URLs, bodies and errors in tests, and logs are asserted not to contain them (spec 19.8).
- Testcontainers, Playwright and axe-core are added with the first database (M1) and the first UI (M1/M2), each with its own ADR entry.

## Licence review: lightningcss (MPL-2.0)

Vitest 4 depends on Vite, which depends on `lightningcss` (MPL-2.0) and a platform binary package. Spec 18.2 permits MPL-2.0 after review.

- Used only at test time on developer machines and CI; **never shipped** in a container or bundle. `pnpm check:licences` enforces a strict allowlist with **no exceptions** for production dependencies.
- MPL-2.0 is file-level copyleft; we neither modify nor distribute it.
- Recorded in `tools/check-licences.mjs` `REVIEWED` against this ADR. **Needs confirmation by a human reviewer** (spec Section 24 item 13).

## Dependencies

| Package               | Why                              | Alternatives                                                                                 | Maintainer health                         | Licence | Supply-chain risk                                                                                                    |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `vitest`              | Test runner                      | Node's built-in `node:test` (no coverage thresholds, weaker DX), Jest (slower, ESM friction) | vitest-dev org, active                    | MIT     | Dev-only. Pulls Vite and native binaries (rolldown, lightningcss) via optional platform packages; no install scripts |
| `@vitest/coverage-v8` | Coverage with V8                 | c8                                                                                           | Same org                                  | MIT     | Dev-only                                                                                                             |
| `fast-check`          | Property-based tests (spec 19.2) | none comparable in TS                                                                        | Long-running, principal maintainer active | MIT     | Dev-only, small dependency tree                                                                                      |
