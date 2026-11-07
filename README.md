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

## Repository settings to apply on GitHub (spec 12.4, 18.1)

Branch protection on `main`: two approvals, CODEOWNER review, signed commits, required status checks (`ci`, `codeql`), squash merge only, no force pushes.
