-- Organisation admin (REQ-010; spec 3.2 "Manage clinicians in org", 21.8).
--
-- org_settings: one row per organisation, changed only by its org_admin through the API, each
-- change audited through the outbox. The review interval default applies when a clinician drafts
-- a treatment without one; languages and the local emergency number are what her app offers.
--
-- clinician: an org_admin may deactivate or reactivate a member and change their role (column
-- grants). The database keeps every organisation with at least one active org_admin, so no
-- admin can lock the organisation out of its own administration.

CREATE TABLE org_settings (
  org_id                        uuid        PRIMARY KEY REFERENCES organization (id),
  default_review_interval_weeks smallint    CHECK (default_review_interval_weeks BETWEEN 4 AND 26),
  languages                     text[]      NOT NULL DEFAULT '{en}'
    CHECK (cardinality(languages) BETWEEN 1 AND 20
           AND array_to_string(languages, ',') ~ '^[a-z]{2}(-[A-Z]{2})?(,[a-z]{2}(-[A-Z]{2})?)*$'),
  emergency_number              text        CHECK (emergency_number ~ '^[0-9]{2,15}$'),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by                    uuid        NOT NULL,
  FOREIGN KEY (updated_by, org_id) REFERENCES clinician (id, org_id)
);

ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org_settings
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- At least one active org_admin per organisation, checked at commit (a role swap in one
  -- transaction is fine).
  EXECUTE format($f$
    CREATE FUNCTION clinician_keep_an_admin() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM %I.clinician
        WHERE org_id = OLD.org_id AND role = 'org_admin' AND active
      ) THEN
        RAISE EXCEPTION 'an organisation needs an active org_admin' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $b$
  $f$, s, s);
  -- updated_at is the database clock, never the caller's.
  EXECUTE format($f$
    CREATE FUNCTION org_settings_stamp() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $b$
  $f$, s);
END
$migration$;

CREATE CONSTRAINT TRIGGER clinician_keep_an_admin AFTER UPDATE OF role, active ON clinician
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clinician_keep_an_admin();
CREATE TRIGGER org_settings_stamp BEFORE INSERT OR UPDATE ON org_settings
  FOR EACH ROW EXECUTE FUNCTION org_settings_stamp();

REVOKE ALL ON org_settings FROM PUBLIC;
GRANT SELECT, INSERT (org_id, default_review_interval_weeks, languages, emergency_number, updated_by),
  UPDATE (default_review_interval_weeks, languages, emergency_number, updated_by)
  ON org_settings TO endo_clinical_app;
GRANT UPDATE (role, active) ON clinician TO endo_clinical_app;
