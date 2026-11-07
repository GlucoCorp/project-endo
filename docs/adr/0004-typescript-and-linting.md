# ADR-0004: Strict TypeScript, ESLint security rules and Prettier

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 8.3, 12.2, 23; RISK-I02

## Context

Spec 8.3 requires strict TypeScript with `noUncheckedIndexedAccess`. Spec 23 requires ESLint and Prettier with security lint rules: no `eval`, no `dangerouslySetInnerHTML`, no raw SQL string concatenation, no `console.log` in services.

## Decision

- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `erasableSyntaxOnly`.
- ESLint flat config (`eslint.config.js`): `typescript-eslint` `strictTypeChecked`, `eslint-plugin-security` recommended, plus project rules:
  - `no-eval`, `no-implied-eval`, `no-new-func`, `no-console`
  - `no-restricted-syntax` bans: `dangerouslySetInnerHTML`; template literals containing SQL keywords; `Math.random`.
- Lint runs with `--max-warnings 0`. A warning fails CI the same as an error.
- Inline disables require a comment explaining why; `reportUnusedDisableDirectives: error` removes stale ones.
- Prettier formats; `format:check` runs in CI.

## Consequences

- `eslint-plugin-security` produces some false positives (object-injection on typed arrays). Prefer rewriting the code (e.g. `DataView`, `Map`) over disabling the rule.

## Alternatives considered

- Biome (lint + format in one binary): fewer type-aware rules and no equivalent security plugin. Rejected for now.

## Dependencies

| Package                  | Why                           | Alternatives                  | Maintainer health                  | Licence    | Supply-chain risk   |
| ------------------------ | ----------------------------- | ----------------------------- | ---------------------------------- | ---------- | ------------------- |
| `typescript`             | Compiler and type checker     | none                          | Microsoft; regular releases        | Apache-2.0 | Dev-only, zero deps |
| `eslint`                 | Linting                       | Biome, oxlint                 | OpenJS Foundation project; active  | MIT        | Dev-only            |
| `typescript-eslint`      | Type-aware TS rules           | none comparable               | Active community org with sponsors | MIT        | Dev-only            |
| `eslint-plugin-security` | Security lint rules (spec 23) | Semgrep only (runs in CI too) | eslint-community org               | Apache-2.0 | Dev-only, small     |
| `prettier`               | Formatting                    | Biome                         | Active org                         | MIT        | Dev-only, zero deps |
| `@types/node`            | Node type definitions         | none                          | DefinitelyTyped                    | MIT        | Types only          |
