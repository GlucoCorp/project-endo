# Rollback

Owner: the release manager on duty.

1. Decide within 15 minutes of a failed deploy or a spike in errors: roll back first, investigate after.
2. Roll the services back to the previous signed image digests (recorded at release), in reverse order: BFFs, jobs, API, identity.
3. Migrations are forward-only and additive (`deploy.md`): the previous release runs against the new schema. Never run a down-migration in production. If a migration itself is faulty, ship a corrective migration.
4. If data was written wrongly, treat it as an incident (`incident-response.md`); restore only with the security lead (`restore.md`).
5. Smoke test as in `deploy.md` and record the rollback in the change log.
