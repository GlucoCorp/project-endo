-- Keycloak database (ADR-0015). Keycloak connects as its owner.
\set db keycloak
\set role keycloak_owner
\set group ''
\unset pw
\getenv pw KEYCLOAK_OWNER_PASSWORD
\ir login.sql
\set owner keycloak_owner
\ir database.sql
