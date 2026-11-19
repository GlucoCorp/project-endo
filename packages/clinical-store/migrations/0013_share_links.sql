-- Share links (REQ-008; spec 5.1, 11.4, 21.7 screen 8): she shares a read-only summary of her
-- treatment history for a limited time, and can stop sharing at any time.
--
-- Only the SHA-256 of the link token is stored; the token exists only in the link (in its URL
-- fragment). Valid at most 30 days (spec 11.4), default 7 (REQ-008). One cross-organisation lookup
-- function, owned by endo_clinical_lookup, finds a live link by its hash and returns ids only.

CREATE TABLE share_link (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  patient_id  uuid        NOT NULL,
  scope       text        NOT NULL DEFAULT 'history_summary' CHECK (scope IN ('history_summary')),
  token_hash  char(64)    NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  -- Her Idempotency-Key (spec 9.1): a retry finds the link it made. The token is shown once and
  -- never again, so a retry is answered with the link's id, not its token.
  creation_key uuid       NOT NULL,
  UNIQUE (patient_id, creation_key),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE INDEX share_link_patient_idx ON share_link (patient_id, created_at DESC);

ALTER TABLE share_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_link FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON share_link
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
CREATE POLICY cross_org_lookup ON share_link FOR SELECT TO endo_clinical_lookup USING (true);
GRANT SELECT (id, org_id, patient_id, token_hash, expires_at, revoked_at)
  ON share_link TO endo_clinical_lookup;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION share_link_find_live(p_token_hash char(64)) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT jsonb_build_object('id', l.id, 'org_id', l.org_id, 'patient_id', l.patient_id,
                                'expires_at', l.expires_at)
      FROM %I.share_link AS l
      WHERE l.token_hash = p_token_hash AND l.revoked_at IS NULL AND l.expires_at > now()
    $b$
  $f$, s, s);

  -- The database sets the times; a link is only ever revoked (once), never changed otherwise.
  EXECUTE format($f$
    CREATE FUNCTION share_link_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.created_at := clock_timestamp();
        NEW.revoked_at := NULL;
        -- At most 30 days by the database's clock, whatever the caller's clock says.
        NEW.expires_at := LEAST(NEW.expires_at, NEW.created_at + interval '30 days');
        IF NEW.expires_at <= NEW.created_at THEN
          RAISE EXCEPTION 'a share link must expire in the future' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'share links are revoked, not deleted' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
         OR ROW(NEW.id, NEW.org_id, NEW.patient_id, NEW.scope, NEW.token_hash, NEW.created_at,
                NEW.expires_at, NEW.creation_key)
            IS DISTINCT FROM
            ROW(OLD.id, OLD.org_id, OLD.patient_id, OLD.scope, OLD.token_hash, OLD.created_at,
                OLD.expires_at, OLD.creation_key) THEN
        RAISE EXCEPTION 'a share link can only be revoked, once' USING ERRCODE = 'check_violation';
      END IF;
      NEW.revoked_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION share_link_find_live(char) OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);
END;
$migration$;

CREATE TRIGGER share_link_guard BEFORE INSERT OR UPDATE OR DELETE ON share_link
  FOR EACH ROW EXECUTE FUNCTION share_link_guard();

REVOKE ALL ON share_link FROM PUBLIC;
REVOKE ALL ON FUNCTION share_link_find_live(char) FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, patient_id, token_hash, expires_at, creation_key) ON share_link
  TO endo_clinical_app;
GRANT UPDATE (revoked_at) ON share_link TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION share_link_find_live(char) TO endo_clinical_app;
