# ADR-0013: PostgreSQL access, SQL migrations and integration testing without Testcontainers

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 2.6, 8.3, 11.3, 18.3, 19.3; RISK-R01, RISK-T02

## Context

The audit log must be durable (spec 2.6, 11.1). Spec 8.3 names PostgreSQL, Kysely with hand-written reviewed SQL migrations, and Testcontainers for integration tests (19.3).

## Decision

- **`pg`** (node-postgres) as the driver and **Kysely** as the typed query builder, wrapped by a new `packages/db`.
- **Migrations:** plain `NNNN_name.sql` files per package (`packages/<pkg>/migrations/`), applied by a ~70-line runner in `packages/db`:
  - one transaction per file, under a Postgres advisory lock;
  - the SHA-256 of each applied file is recorded, and an edited applied migration is an error.

  Kysely's own migrator expects TypeScript migration modules, and the spec wants reviewable SQL.

- **Migrations run as a separate release step** (`pnpm --filter @endo/audit migrate`) with a migration-owner role. Services connect as members of least-privilege roles (`endo_audit_app`: SELECT and INSERT only).
- **Integration tests use a plain Postgres container, not Testcontainers.**
  - Testcontainers pulls in ~15 direct dependencies, including `ssh2`, which runs an install script and optionally compiles `cpu-features` with node-gyp. That conflicts with our "no install scripts" supply-chain rule (ADR-0003) and adds a large dependency tree.
  - CI runs the same digest-pinned `postgres:18.6-alpine` image as a job **service container**. Locally, `pnpm db:test:up` starts it.
  - Each test gets an isolated schema (`testSchemaPool`).
  - `testDatabaseUrl()` **throws in CI** if the URL is missing, so integration tests can never be skipped silently there. Locally they skip without a database, and that code is then left out of local coverage; CI always measures it.
- **Data inventory gate:** `tools/check-data-inventory.mjs` parses `CREATE TABLE` and `ADD COLUMN` statements and fails CI if a column is missing from `docs/data-inventory.md` (spec 11.3).

## Consequences

- Keycloak integration tests (M1) will use the same pattern: a service container in CI and `docker run` locally.
- Row-level security (`app.org_id`, spec 10.4) arrives with the first clinical tables in M1, using this runner.

## Alternatives considered

- Testcontainers: see above.
- `postgres` (porsager) driver: good, but Kysely's built-in dialect targets `pg`. Rejected.
- Prisma or Drizzle migrations: generate SQL from a schema DSL, which hides the SQL the spec wants reviewed. Rejected.

## Dependencies

| Package            | Why                          | Alternatives           | Maintainer health                                 | Licence | Supply-chain risk                                                                                                                           |
| ------------------ | ---------------------------- | ---------------------- | ------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg@8.23.1`        | PostgreSQL driver            | `postgres`             | Very widely used, long-running maintainer, active | MIT     | Runtime. Small pure-JS tree (`pg-pool`, `pg-protocol`, `pg-types`, `pgpass`); no install scripts. Optional `pg-native` is **not** installed |
| `kysely@0.28.18`   | Typed SQL builder (spec 8.3) | raw parameterised `pg` | Active, sponsored                                 | MIT     | Runtime, zero dependencies. 0.29.x was under 7 days old                                                                                     |
| `@types/pg@8.23.1` | Types                        | none                   | DefinitelyTyped                                   | MIT     | Dev/types only                                                                                                                              |
