# CLAUDE.md

Project Endo: measured treatment trials for endometriosis, adenomyosis and fibroids. Medical-grade software handling reproductive health data. **The full specification is [`PROJECT_ENDO_BUILD_SPEC.md`](PROJECT_ENDO_BUILD_SPEC.md); it is the single source of truth.** Read its Section 0 before writing code.

## Operating rules (spec Section 0)

1. Security and privacy first. If a shortcut weakens any control in spec Section 12, stop and ask.
2. Never use real patient data outside production. Synthetic data only.
3. No new dependency (runtime or dev) without an ADR in `docs/adr/`: why, alternatives, maintainer health, licence, supply-chain risk.
4. Never weaken, skip or delete a test or CI check to make a build pass. Fix the cause.
5. Never write clinical logic from your own judgement. Thresholds, wording and red flags come only from signed-off `clinical/` files. `TODO_CLINICAL` values stay obviously unfinished.
6. Every change traces to `REQ-…` / `RISK-…` IDs in commit messages and tests.
7. Security-relevant PRs get the `security-review` label and a threat note.
8. Small PRs, one concern each; under 400 changed lines when touching auth, crypto, consent, audit or verdict.
9. Update docs, ADRs, threat model and data inventory in the same change as the code.
10. When the spec is ambiguous, add the question to spec Section 24 and continue with something else.

## Non-negotiables (spec Section 2), in short

No PHI leaves the region · no third-party scripts, fonts or trackers · **no PHI in logs, errors, URLs, notifications, analytics or Git** · identity and clinical data in separate databases with separate keys · **deny by default: every route declares a policy** · every health-data access audited · phishing-resistant MFA for staff · no long-lived secrets · clinical logic is signed-off configuration · **red flags always win** · she can export and delete her data · integrations fail closed.

## Working in this repo

- Node 24 LTS (`.nvmrc`), pnpm 12. `pnpm install` then `pnpm check:all` (format, typecheck, lint with zero warnings, tests with coverage gates, licences, READMEs).
- Workspace packages export TypeScript source; services run with Node's native type stripping (`node src/main.ts`). Use only erasable TS syntax (no enums, no parameter properties).
- Commits: Conventional Commits with IDs, e.g. `feat(checkin): offline queue (REQ-003, RISK-S02)`.
- Tests name what they verify: `describe('REQ-003 …')`. Push `SYNTHETIC_PHI_MARKER` through new surfaces and assert it never appears in logs or errors.
- New API routes must declare `config.policy`; new BFF routes `config.auth`. The service will not start otherwise.
- Security-critical packages (`authz`, `crypto`, `audit`, `service-kit`, later `verdict`) need 90% coverage and a named human reviewer.
- AI tools never receive real patient data, production secrets or production logs (spec 12.11).

## Where things are

`packages/` libraries · `services/` deployables · `clinical/` clinician-owned content · `docs/adr/` decisions · `docs/threat-model.md` · `docs/data-inventory.md` · `docs/requirements/`, `docs/risk/` registers · `tools/` repo checks · `infra/dev/` local stack.
