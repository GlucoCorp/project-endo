-- Cluster roles for the session store (ADR-0033). Run by a privileged role (the infrastructure's
-- roles Job, CI) BEFORE migrations.
--
-- endo_sessions_app  the BFFs' permissions on browser sessions (login roles: bff_patient_sessions,
--                    bff_clinic_sessions). No other service holds it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_sessions_app') THEN
    CREATE ROLE endo_sessions_app NOLOGIN;
  END IF;
END;
$$;
