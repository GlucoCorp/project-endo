# ADR-0011: Override minimatch to 11.0.3 (GHSA-g3hv-75wg-m249)

- Status: accepted
- Date: 2026-11-07
- Risks: RISK-T02

## Context

OSV-Scanner in CI flagged `minimatch@10.2.6` (GHSA-g3hv-75wg-m249, CVSS 6.9, Medium): attacker-controlled glob patterns can cause amplified, quadratic preprocessing (denial of service). Affected range is 7.0.0 up to 11.0.1. There is no fixed 10.x release.

`minimatch` reaches us only through dev tooling: `eslint`, `@eslint/config-array` and `@typescript-eslint/typescript-estree`, all of which declare `^10`. In our use the glob patterns come from our own lint config, so practical exploitability is negligible. Still, the scanner is a required check (spec 18.2), and the rules forbid weakening it (spec 0 rule 4).

## Decision

Add a pnpm `overrides` entry pinning `minimatch` to **11.0.3**. That is the newest fixed release that clears the 7-day minimum release age; 11.0.4 and 11.0.5 were younger on the decision date.

Compatibility check: 11.0 removes `makeRe()`, `Minimatch#regexp`, `AST`, `debug`, `matchOne()` and `slashSplit()`. The three dependents use only `new Minimatch(pattern, options)`, `Minimatch#match(path, partial?)` and the `minimatch(path, pattern, options)` function, and all three are retained. The full lint run passes with the override.

## Consequences

- Introduces transitive dependencies `@isaacs/nonrecursive-glob-match` (BlueOak-1.0.0, same maintainer as minimatch, first published 2026-10-26) and `brace-expansion@5`. Both are dev-only.
- **Remove this override** once ESLint and typescript-eslint depend on a fixed `minimatch` directly. Renovate will surface it.

## Alternatives considered

- Time-boxed OSV ignore entry: leaves the vulnerable code installed. Rejected while a compatible fix exists.
- Waiting for upstream: blocks CI indefinitely. Rejected.

## Dependencies

| Package                                        | Why                       | Alternatives | Maintainer health                 | Licence       | Supply-chain risk                                              |
| ---------------------------------------------- | ------------------------- | ------------ | --------------------------------- | ------------- | -------------------------------------------------------------- |
| `minimatch@11.0.3` (override)                  | Fixes GHSA-g3hv-75wg-m249 | ignore entry | Long-standing maintainer (isaacs) | BlueOak-1.0.0 | Dev-only                                                       |
| `@isaacs/nonrecursive-glob-match` (transitive) | Required by minimatch 11  | none         | Same maintainer; new package      | BlueOak-1.0.0 | Dev-only; new package, pinned by lockfile and release-age gate |
