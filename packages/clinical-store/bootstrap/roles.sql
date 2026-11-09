-- Cluster roles for the clinical store (ADR-0017). Run ONCE per cluster by a privileged
-- bootstrap (infrastructure, CI), BEFORE migrations. Migrations run as the database owner, which
-- cannot create roles, and refuse to run if these are missing.
--
-- endo_clinical_app     API's permissions (login roles such as clinical_api are members)
-- endo_clinical_lookup  owns the one cross-organisation lookup function; no login, no members
--                       except the migration owner (needed to assign function ownership)
-- endo_clinical_relay   reads and acknowledges the audit outbox across organisations; the API
--                       role can only add to it (login role: clinical_relay)
-- endo_clinical_membership_lookup  owns the one cross-organisation membership lookup (ADR-0019);
--                       no login, no members except the migration owner
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_app') THEN
    CREATE ROLE endo_clinical_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_lookup') THEN
    CREATE ROLE endo_clinical_lookup NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_relay') THEN
    CREATE ROLE endo_clinical_relay NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_membership_lookup') THEN
    CREATE ROLE endo_clinical_membership_lookup NOLOGIN;
  END IF;
END;
$$;
