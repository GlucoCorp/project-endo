-- Cluster roles for the clinical store (ADR-0017). Run ONCE per cluster by a privileged
-- bootstrap (infrastructure, CI), BEFORE migrations. Migrations run as the database owner, which
-- cannot create roles, and refuse to run if these are missing.
--
-- endo_clinical_app     API's permissions (login roles such as clinical_api are members)
-- endo_clinical_lookup  owns the one cross-organisation lookup function; no login, no members
--                       except the migration owner (needed to assign function ownership)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_app') THEN
    CREATE ROLE endo_clinical_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_lookup') THEN
    CREATE ROLE endo_clinical_lookup NOLOGIN;
  END IF;
END;
$$;
