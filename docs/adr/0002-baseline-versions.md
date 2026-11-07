# ADR-0002: Baseline versions

- Status: accepted
- Date: 2026-11-07
- Requirements: spec 8.3, 12.4

## Context

Spec 8.3 requires every version pinned at build time to the current stable or LTS release and recorded here. Spec 12.4 requires a minimum release age of 7 days for new dependency versions.

## Decision

Exact versions (no ranges) are pinned in `package.json` files; `pnpm-lock.yaml` pins the full tree. Each version below is the newest stable release that was **at least 7 days old** on 2026-11-07 and compatible with the rest of the set.

| Component                    | Version                                      | Notes                                                                                                                                     |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                      | 24.22.2 (LTS "Krypton")                      | Active LTS. Pinned in `.nvmrc` and `engines`. Native TypeScript type stripping runs services without a build step                         |
| pnpm                         | 12.5.1                                       | `packageManager` field                                                                                                                    |
| TypeScript                   | 6.0.3                                        | **Not 7.0.x**: TypeScript 7 (native port) is newer, but typescript-eslint 8.72 supports `<6.1`. Revisit when typescript-eslint supports 7 |
| Turborepo                    | 2.11.10                                      |                                                                                                                                           |
| Fastify                      | 5.12.7                                       | 5.12.8 was under 7 days old                                                                                                               |
| Zod                          | 4.6.7                                        |                                                                                                                                           |
| jose                         | 6.2.14                                       |                                                                                                                                           |
| Vitest / @vitest/coverage-v8 | 4.1.12                                       | 5.x releases were under 7 days old                                                                                                        |
| fast-check                   | 4.10.2                                       |                                                                                                                                           |
| ESLint                       | 10.14.0                                      |                                                                                                                                           |
| typescript-eslint            | 8.72.1                                       |                                                                                                                                           |
| eslint-plugin-security       | 4.2.1                                        |                                                                                                                                           |
| Prettier                     | 3.9.10                                       |                                                                                                                                           |
| @types/node                  | 24.19.2                                      | Matches Node 24                                                                                                                           |
| PostgreSQL (dev container)   | 18.6-alpine, pinned by digest                |                                                                                                                                           |
| Keycloak (dev container)     | 26.8.2, pinned by digest                     |                                                                                                                                           |
| GitHub Actions               | pinned to full commit SHAs in workflow files |                                                                                                                                           |

## Consequences

- Renovate (weekly, grouped, 7-day minimum age, no auto-merge for runtime dependencies) proposes updates; each major bump updates this ADR.
- The TypeScript 6 pin is a known lag; tracked in this ADR.

## Alternatives considered

- Version ranges (`^`): rejected; the lockfile alone is not enough protection when lockfiles are regenerated.
