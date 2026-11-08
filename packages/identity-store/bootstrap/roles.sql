-- Cluster roles for the identity vault (spec 5.2; ADR-0017). Run ONCE per cluster by a privileged
-- bootstrap (infrastructure, CI), BEFORE migrations. Migrations run as the database owner, which
-- cannot create roles, and refuse to run if this is missing.
--
-- endo_identity_app  the identity service's permissions (login role identity_api is a member).
--                    No other service may hold it: only the identity service touches this database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_identity_app') THEN
    CREATE ROLE endo_identity_app NOLOGIN;
  END IF;
END;
$$;
