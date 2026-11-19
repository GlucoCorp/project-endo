-- SMART Backend Services assertion ids, used once (M7; spec 16.3; Codex review r7).
--
-- Each (client_id, jti) is reserved until the assertion expires (at most 5 minutes ahead), in the
-- database, so a replay is refused across restarts and across integration-service instances.
-- No patient data. Reachable only through integration_assertion_reserve(): row-level security is
-- on with no policy, so the application role cannot read or change the table directly.

CREATE TABLE integration_assertion (
  client_id   text        NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{22,64}$'),
  jti         text        NOT NULL CHECK (char_length(jti) BETWEEN 1 AND 255),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (client_id, jti)
);
CREATE INDEX integration_assertion_expiry_idx ON integration_assertion (expires_at);
ALTER TABLE integration_assertion ENABLE ROW LEVEL SECURITY;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- True the first time; false if this id was seen and has not expired. Expired ids are removed
  -- a few at a time on each call, so the table stays small.
  EXECUTE format($f$
    CREATE FUNCTION integration_assertion_reserve(p_client_id text, p_jti text,
                                                  p_expires_at timestamptz) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    DECLARE
      v_inserted boolean;
    BEGIN
      DELETE FROM %I.integration_assertion
        WHERE ctid IN (SELECT ctid FROM %I.integration_assertion
                       WHERE expires_at < now() LIMIT 100);
      INSERT INTO %I.integration_assertion (client_id, jti, expires_at)
        VALUES (p_client_id, p_jti, least(p_expires_at, now() + interval '5 minutes'))
        ON CONFLICT (client_id, jti) DO UPDATE
          SET expires_at = EXCLUDED.expires_at
          WHERE integration_assertion.expires_at < now()
        RETURNING true INTO v_inserted;
      RETURN coalesce(v_inserted, false);
    END;
    $b$
  $f$, s, s, s, s);
END
$migration$;

REVOKE ALL ON integration_assertion FROM PUBLIC;
REVOKE ALL ON FUNCTION integration_assertion_reserve(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_assertion_reserve(text, text, timestamptz)
  TO endo_clinical_app;
