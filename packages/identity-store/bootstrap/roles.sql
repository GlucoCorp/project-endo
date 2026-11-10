-- Cluster roles for the identity vault (spec 5.2; ADR-0017).
-- Run by a privileged role (the infrastructure's roles Job, CI), BEFORE
-- migrations. Migrations run as the database owner, which cannot create roles, and refuse to run if this is missing.
--
-- endo_identity_app  the identity service's permissions (login role identity_api is a member).
--                    No other service may hold it: only the identity service touches this database.
-- endo_identity_relay reads and acknowledges the audit outbox; the service role can only add to
--                    it (login role: identity_relay)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_identity_app') THEN
    CREATE ROLE endo_identity_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_identity_relay') THEN
    CREATE ROLE endo_identity_relay NOLOGIN;
  END IF;
END;
$$;
