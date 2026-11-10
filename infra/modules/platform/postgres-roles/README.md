# postgres-roles

Idempotent SQL that brings every database, owner and login role to the state the platform expects (spec 2.4, 11.1; ADR-0013, ADR-0017). The `postgres-<instance>-roles` Job runs it on every `tofu apply` whose scripts changed, on new and existing volumes alike. It replaces the old first-boot script, which only ran on a new volume.

Order per instance:

1. `common.sql`
2. for each database it hosts:
   - that store's own `packages/*/bootstrap/roles.sql` (group roles that cannot log in; the only list of them);
   - then `<db>.sql` (owner, database, login roles, memberships, CONNECT);
   - for clinical, then `packages/clinical-store/bootstrap/grant-owner.sql`.

Passwords come from environment variables through psql `\getenv`, never from the command line. A missing password stops the run.

CI runs the same files twice against its test Postgres and checks the result (`tools/check-postgres-roles.sh`).
