-- Grants the migration owner the group roles it needs to assign function ownership (ADR-0017,
-- ADR-0019). Idempotent. Run as a privileged role AFTER roles.sql and BEFORE migrations, both on
-- a new cluster and when upgrading an existing one. The infrastructure's roles Job runs it on every
-- apply (infra/modules/platform/postgres-roles); by hand:
--
--   psql "$PRIVILEGED_URL" -v ON_ERROR_STOP=1 -f bootstrap/roles.sql
--   psql "$PRIVILEGED_URL" -v ON_ERROR_STOP=1 -v owner=clinical_owner -f bootstrap/grant-owner.sql
GRANT endo_clinical_lookup TO :"owner";
GRANT endo_clinical_membership_lookup TO :"owner";
