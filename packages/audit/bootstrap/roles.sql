-- Cluster role for the audit store (ADR-0013). Run by a privileged
-- role (the infrastructure's roles Job, CI), BEFORE migrations. Idempotent.
--
-- endo_audit_app  SELECT and INSERT on audit_event only (login role audit_api is a member)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_audit_app') THEN
    CREATE ROLE endo_audit_app NOLOGIN;
  END IF;
END;
$$;
