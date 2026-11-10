# Project Endo

Measured treatment trials for endometriosis, adenomyosis and fibroids. GluCorp Health.

- Specification: [`PROJECT_ENDO_BUILD_SPEC.md`](PROJECT_ENDO_BUILD_SPEC.md)
- How to work here: [`CLAUDE.md`](CLAUDE.md)
- Decisions: [`docs/adr/`](docs/adr/) · Threat model: [`docs/threat-model.md`](docs/threat-model.md) · Data inventory: [`docs/data-inventory.md`](docs/data-inventory.md)

## Status

Milestone **M0 Foundations**, first slice: monorepo, CI, `config`, `domain`, `crypto`, `audit`, `authz`, `service-kit`, and a walking skeleton (`GET /v1/hello` through `bff-patient` → service token → `api` → authz → audit).

Not yet built in M0: Terraform dev environment, Keycloak dev realm, container images with signing and provenance, AWS KMS / Vault key managers, Postgres audit store.

## Prerequisites

- Node.js 24 LTS (see `.nvmrc`), pnpm 12.5+
- Docker (for the local database and Keycloak stack)

## Common commands

```sh
pnpm install
pnpm check:all          # format, typecheck, lint (0 warnings), tests + coverage, licences, READMEs
pnpm check:clinical     # list unfinished clinical, licence and legal content
```

## One-time setup per clone

```sh
git config core.hooksPath .githooks   # gitleaks secret scan before each commit (uses gitleaks or Docker)
```

## Run the walking skeleton locally

```sh
eval "$(node tools/dev-keys.mjs)"     # fresh dev-only service-token keys
export ENDO_ENV=dev ENDO_CLINICAL_RULESET_PATH="$PWD/clinical/rulesets/ruleset.1.0.0.yaml"
export API_PORT=4101 BFF_PATIENT_PORT=4100 BFF_PATIENT_API_BASE_URL=http://127.0.0.1:4101 BFF_PATIENT_DEV_SESSIONS_ENABLED=true
(cd services/api && node src/main.ts) &
(cd services/bff-patient && node src/main.ts) &     # prints a synthetic patient session cookie
curl -H "cookie: __Host-endo_session=<token>" http://127.0.0.1:4100/v1/hello
```

In `staging` or `production` the API refuses to start while the rule set contains `TODO_CLINICAL`.

## Container images

One `Dockerfile` builds every service (ADR-0016): distroless Node 24, non-root, no shell, read-only filesystem.

```sh
docker build --build-arg SERVICE=api -t endo-api .
docker build --build-arg SERVICE=bff-patient -t endo-bff-patient .
```

CI (`.github/workflows/images.yml`) scans every image and keeps a CycloneDX SBOM. On `main` it pushes to private GHCR, signs with Sigstore keyless signing and attaches the SBOM as a signed attestation. Verify before deploying (by digest):

```sh
cosign verify \
  --certificate-identity https://github.com/GlucoCorp/project-endo/.github/workflows/images.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/glucocorp/endo-api@sha256:<digest>
```

## Security scanning on a free GitHub plan

GitHub Code Security (paid) is not enabled. The free set-up gives equivalent blocking checks:

| Need                    | Free mechanism                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code scanning           | CodeQL + Semgrep in CI; findings become inline PR annotations and a job-summary table via `tools/sarif-report.mjs`; any finding fails the build, except one reviewed and accepted in `.github/scan-accepted.json` (tool, rule, file, the exact line, justification, approver; the line's text must still match, and unused entries fail the build) |
| Vulnerable dependencies | OSV-Scanner + Trivy on every PR and weekly on `main`; Dependabot alerts (free, enabled); Renovate opens fix PRs                                                                                                                                                                                                                                    |
| Secrets                 | gitleaks in CI (full history) and as a pre-commit hook                                                                                                                                                                                                                                                                                             |
| SBOM                    | CycloneDX artefact on every CI run                                                                                                                                                                                                                                                                                                                 |

GitHub Free gives 2,000 private-repo Actions minutes a month; each push uses roughly 5 to 6.

## Repository settings (spec 12.4, 18.1)

- Applied: squash-merge only, branches deleted after merge.
- **Not available on GitHub Free for private repos:** branch protection and rulesets (required reviews, required checks, signed commits, no force pushes). Compensating control: the `main-guard` workflow flags any commit on `main` that did not come from a merged PR (RISK-T04). Always merge through a PR with green checks.
- When the plan allows: protect `main` with required checks (`typecheck, lint, tests, coverage, licences`, `security scans …`, `analyze`), two approvals, CODEOWNER review, signed commits, no force pushes.
