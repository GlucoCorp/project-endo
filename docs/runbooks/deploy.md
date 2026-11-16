# Deploy

Spec 12.4, 17 (environments), ADR-0016 (signed images). Owner: the release manager on duty.

## Before

- `main` is green: format, typecheck, lint (zero warnings), tests with coverage gates, licences, READMEs, data inventory, realm checks, CodeQL, Semgrep, gitleaks, Trivy, OSV.
- The release candidate passed DAST (ZAP baseline) in staging (spec 12.7).
- Migrations in the release are additive or have a tested backfill; destructive changes ship in a later release.
- The clinical rule set is signed (`tools/sign-ruleset.mjs`); the API refuses to start otherwise in staging and production.
- No `TODO_CLINICAL` remains for any feature that is switched on in that environment (`pnpm check:clinical`).

## Steps

1. Tag the release; CI builds and signs the images (Sigstore keyless, ADR-0016) and records the digests.
2. Verify the signatures and digests in the target cluster's admission policy (unsigned images are refused).
3. Run migrations with each database's owner role (`pnpm --filter @endo/clinical-store migrate`, identity, audit), one database at a time, before rolling the services.
4. Roll the services one at a time: identity, API, jobs, BFFs, Keycloak extension if changed. Wait for health checks and watch error rates for 10 minutes each.
5. Smoke test with synthetic accounts: patient sign-in, check-in, red flag screen, clinician sign-in, review queue, export.
6. Announce the release in the change log.

If any step fails, stop and follow `rollback.md`.
