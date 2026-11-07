# ADR-0003: Monorepo with pnpm workspaces, Turborepo and supply-chain controls

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 8.1, 8.2, 12.4; RISK-T02

## Context

The spec mandates one TypeScript monorepo (8.1) with the layout in 8.2, strict dependency isolation, and supply-chain controls (12.4).

## Decision

- **pnpm workspaces** with `nodeLinker: isolated`: a package can only import what it declares.
- **Turborepo** orchestrates `typecheck`, `lint`, `test`, `test:coverage` across packages with caching.
- Workspace packages export TypeScript source (`exports: ./src/index.ts`). Services run on Node 24 native type stripping; `erasableSyntaxOnly` in `tsconfig.base.json` keeps all code compatible (no enums, no parameter properties).
- Supply-chain settings in `pnpm-workspace.yaml` and `.npmrc`:
  - `minimumReleaseAge: 10080` (7 days)
  - `strictDepBuilds: true` with an **empty** `onlyBuiltDependencies` allowlist; `ignore-scripts=true`
  - `saveExact`, `strictPeerDependencies`, `engineStrict`
  - CI installs with `--frozen-lockfile`
- Renovate: weekly, grouped, `minimumReleaseAge: 7 days`, no auto-merge for runtime dependencies (`renovate.json`).
- Added one package not listed in spec 8.2: `packages/service-kit` (ADR-0006).

## Consequences

- No install scripts run anywhere. A future dependency that needs one (e.g. a native module) requires an ADR amendment adding it to the allowlist.
- Tooling (`vitest`, `eslint`, `typescript`) is declared once at the root and resolved by ancestor lookup.

## Alternatives considered

- npm workspaces: weaker isolation (hoisting), no release-age gate. Rejected.
- Nx: heavier, more plugins and configuration surface. Rejected for a small team.

## Dependencies

| Package | Why                            | Alternatives                       | Maintainer health                       | Licence | Supply-chain risk                                                                           |
| ------- | ------------------------------ | ---------------------------------- | --------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `turbo` | Task orchestration and caching | pnpm `-r` scripts (no caching), Nx | Maintained by Vercel; frequent releases | MIT     | Dev-only. Ships a prebuilt native binary via optional platform packages; no install scripts |
