-- Identity database (ADR-0017, ADR-0021). Run after packages/identity-store/bootstrap/roles.sql.
\set db identity
\set role identity_owner
\set group ''
\unset pw
\getenv pw IDENTITY_OWNER_PASSWORD
\ir login.sql
\set owner identity_owner
\ir database.sql

-- The identity service, through endo_identity_app.
\set role identity_api
\set group endo_identity_app
\getenv pw IDENTITY_API_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE identity TO identity_api;

-- The audit outbox relay, through endo_identity_relay.
\set role identity_relay
\set group endo_identity_relay
\getenv pw IDENTITY_RELAY_PASSWORD
\ir login.sql
GRANT CONNECT ON DATABASE identity TO identity_relay;
