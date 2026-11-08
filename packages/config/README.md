# @endo/config

**Purpose:** typed, validated configuration for every service (spec 8.2), plus the clinical release gate (spec 7.3).

**Owners:** platform engineering. Changes to the clinical gate also need clinical-safety review.

## Public API

| Export                                         | What it does                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Environment`                                  | Zod enum: `dev`, `test`, `staging`, `production`                                                                     |
| `isDeployedEnvironment(env)`                   | `true` for staging and production                                                                                    |
| `loadConfig(schema, env)`                      | Parse environment variables with a Zod object schema; throws `ConfigError` listing variable names only, never values |
| `assertClinicalReleaseReady(env, rulesetText)` | In staging or production, throws `ClinicalNotReadyError` if any `TODO_CLINICAL` remains                              |

## Rules

- Secrets are read from the environment populated by the secrets manager at startup (spec 12.5). Never default a secret.
- Feature flags (spec 18.3) will live here; they must never bypass a security control.
