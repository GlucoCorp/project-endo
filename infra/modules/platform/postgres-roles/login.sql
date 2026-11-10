-- Creates or updates one login role. Idempotent.
-- Input psql variables: role, group ('' for none), pw (from \getenv; must be set).
-- The role gets exactly LOGIN and the password; any stronger attribute is removed.
\if :{?pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'postgres-roles: a login password is missing'; END $$;
\endif
SELECT format('CREATE ROLE %I LOGIN', :'role')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'role', :'pw') \gexec
SELECT format('GRANT %I TO %I', :'group', :'role') WHERE :'group' <> '' \gexec
\unset pw
