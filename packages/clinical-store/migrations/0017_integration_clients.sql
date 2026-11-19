-- Record-system integrations (M7; spec 16.3, 9.3; RISK-E02).
--
-- One row per SMART Backend Services client of an organisation: its public keys (a JWK Set; no
-- private key ever reaches us), the scopes it may ask for, and `active`, the organisation admin's
-- kill switch. The integration service finds a client by its client_id through a lookup function
-- (cross-organisation, owned by endo_clinical_lookup), and re-checks it on every request, so
-- switching a client off takes effect at once.

CREATE TABLE integration_client (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES organization (id),
  client_id   text        NOT NULL UNIQUE CHECK (client_id ~ '^[A-Za-z0-9_-]{22,64}$'),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  jwks        jsonb       NOT NULL CHECK (jsonb_typeof(jwks -> 'keys') = 'array'
                                          AND octet_length(jwks::text) <= 16384),
  scopes      text[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 20),
  active      boolean     NOT NULL DEFAULT true,
  created_by  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by, org_id) REFERENCES clinician (id, org_id)
);

ALTER TABLE integration_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_client FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integration_client
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
CREATE POLICY cross_org_lookup ON integration_client FOR SELECT TO endo_clinical_lookup USING (true);
GRANT SELECT (id, org_id, client_id, jwks, scopes, active) ON integration_client
  TO endo_clinical_lookup;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION integration_client_find(p_client_id text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT jsonb_build_object('id', id, 'org_id', org_id, 'jwks', jwks, 'scopes', scopes,
                                'active', active)
      FROM %I.integration_client WHERE client_id = p_client_id
    $b$
  $f$, s, s);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION integration_client_find(text) OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);
END
$migration$;

REVOKE ALL ON integration_client FROM PUBLIC;
REVOKE ALL ON FUNCTION integration_client_find(text) FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, client_id, name, jwks, scopes, created_by)
  ON integration_client TO endo_clinical_app;
GRANT UPDATE (active) ON integration_client TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION integration_client_find(text) TO endo_clinical_app;
