# @endo/db

**Purpose:** PostgreSQL connection pools, the Kysely query builder, and a forward-only runner for hand-written SQL migrations (spec 8.3, 18.3; ADR-0013).

**Owners:** platform engineering. Migrations touching audit, consent or identity tables need security review.

## Public API

| Export                                                                           | What it does                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPool(url, options)`                                                       | pg pool with statement, idle-transaction and connect timeouts                                                                                                                             |
| `createDb<Schema>(pool)`                                                         | Typed Kysely instance                                                                                                                                                                     |
| `relayAuditOutbox(db, publish, max?)`, `OUTBOX_MAX_ATTEMPTS`, `AuditOutboxTable` | Relays a store's audit outbox to the audit store, one locked event per transaction; failures are counted with a safe code and set aside after 5 (spec 2.6). Run as the store's relay role |
| `runMigrations(pool, dir)`                                                       | Applies `NNNN_name.sql` files in order, one transaction each, under an advisory lock. Refuses to run if an applied file has changed                                                       |
| `testDatabaseUrl()`                                                              | Integration-test database URL; throws in CI if missing                                                                                                                                    |

## Rules

- Migrations are immutable once applied. Change the schema with a new migration (expand, migrate, contract; spec 18.3).
- Every new column needs an entry in `docs/data-inventory.md`; `pnpm check:inventory` enforces it (spec 11.3).
- No raw SQL built from strings in application code; use Kysely or parameterised queries.

## Local integration tests

```sh
pnpm db:test:up      # throwaway Postgres on 127.0.0.1:15499, synthetic data only
export ENDO_TEST_DATABASE_URL=postgres://endo_test:endo_test@127.0.0.1:15499/endo_test
pnpm test
pnpm db:test:down
```
