-- Sessions database (ADR-0033). Run after packages/session-store/bootstrap/roles.sql.
\set db sessions
\set role sessions_owner
\set group ''
\unset pw
\getenv pw SESSIONS_OWNER_PASSWORD
\ir login.sql
\set owner sessions_owner
\ir database.sql

-- Each BFF, through endo_sessions_app (sessions only: no other database).
\set role bff_patient_sessions
\set group endo_sessions_app
\getenv pw BFF_PATIENT_SESSIONS_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE sessions TO bff_patient_sessions;

\set role bff_clinic_sessions
\set group endo_sessions_app
\getenv pw BFF_CLINIC_SESSIONS_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE sessions TO bff_clinic_sessions;
