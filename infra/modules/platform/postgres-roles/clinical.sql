-- Clinical database (ADR-0017). Run after packages/clinical-store/bootstrap/roles.sql and
-- before packages/clinical-store/bootstrap/grant-owner.sql, which grants the migration owner the
-- lookup roles. This file ends with :owner set to clinical_owner for that script.
\set db clinical
\set role clinical_owner
\set group ''
\unset pw
\getenv pw CLINICAL_OWNER_PASSWORD
\ir login.sql
\set owner clinical_owner
\ir database.sql

-- The API, through endo_clinical_app.
\set role clinical_api
\set group endo_clinical_app
\getenv pw CLINICAL_API_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE clinical TO clinical_api;

-- The jobs process (ADR-0029), through endo_clinical_app with its own login.
\set role clinical_jobs
\set group endo_clinical_app
\getenv pw CLINICAL_JOBS_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE clinical TO clinical_jobs;

-- The audit outbox relay, through endo_clinical_relay.
\set role clinical_relay
\set group endo_clinical_relay
\getenv pw CLINICAL_RELAY_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE clinical TO clinical_relay;

\set owner clinical_owner
