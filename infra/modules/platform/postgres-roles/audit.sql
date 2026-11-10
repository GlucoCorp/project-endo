-- Audit database (ADR-0013). Run after packages/audit/bootstrap/roles.sql.
\set db audit
\set role audit_owner
\set group ''
\unset pw
\getenv pw AUDIT_OWNER_PASSWORD
\ir login.sql
\set owner audit_owner
\ir database.sql

-- The audit service: SELECT and INSERT only, through endo_audit_app.
\set role audit_api
\set group endo_audit_app
\getenv pw AUDIT_API_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE audit TO audit_api;
