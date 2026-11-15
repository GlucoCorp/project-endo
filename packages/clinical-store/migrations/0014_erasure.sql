-- Account deletion with a 14-day grace period, then hard deletion and crypto-shredding (REQ-009;
-- spec 11.4, 13.3).
--
-- Append-only tables stay append-only for the API: their triggers now allow a DELETE only when
-- the current user owns the table, which happens only inside patient_erase() (SECURITY DEFINER,
-- owned by the schema owner). The API role never owns a table. patient_erase() erases one patient
-- only when she asked (deletion_request), her 14 days have passed and she did not cancel.
--
-- Audit events hold no PHI and are kept (REQ-009 acceptance). Backups expire on their schedule.

CREATE TABLE deletion_request (
  id             uuid        PRIMARY KEY,
  org_id         uuid        NOT NULL,
  -- No foreign key: the request outlives her patient record as the record of the erasure.
  patient_id     uuid        NOT NULL,
  -- Opaque pointer to her identity record, so the identity service can erase it too.
  identity_ref   uuid        NOT NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  due_at         timestamptz NOT NULL,
  cancelled_at   timestamptz,
  erased_at      timestamptz,
  identity_erased_at timestamptz,
  CHECK (cancelled_at IS NULL OR erased_at IS NULL)
);
-- One open request per patient.
CREATE UNIQUE INDEX deletion_request_open ON deletion_request (patient_id)
  WHERE cancelled_at IS NULL;

ALTER TABLE deletion_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_request FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON deletion_request
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
CREATE POLICY cross_org_lookup ON deletion_request FOR SELECT TO endo_clinical_lookup USING (true);
GRANT SELECT (id, org_id, patient_id, identity_ref, due_at, cancelled_at, erased_at,
  identity_erased_at) ON deletion_request TO endo_clinical_lookup;

DO $migration$
DECLARE
  s text := current_schema();
  -- Inside a trigger: is the current user the table's owner (only patient_erase runs as it)?
  owner text := 'current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))';
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION consent_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' AND %s THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'consent is append-only (%% refused)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $b$
  $f$, s, owner);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION m2_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' AND %s THEN RETURN OLD; END IF;
      RAISE EXCEPTION '%% is append-only (%% refused)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $b$
  $f$, s, owner);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION verdict_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.generated_at := clock_timestamp();
        NEW.shadow := true;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' AND %s THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'verdicts are append-only (%% refused)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $b$
  $f$, s, owner);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION review_decision_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' AND %s THEN RETURN OLD; END IF;
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'decisions are append-only (%% refused)', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM %I.treatment_episode WHERE id = NEW.episode_id
                     AND status = 'closed') THEN
        RAISE EXCEPTION 'a decision is recorded as its episode closes' USING ERRCODE = 'check_violation';
      END IF;
      NEW.decided_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s, owner, s);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION surgery_check_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' AND %s THEN RETURN OLD; END IF;
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'pre-surgery checks are append-only (%% refused)', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.acknowledged_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s, owner);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION share_link_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.created_at := clock_timestamp();
        NEW.revoked_at := NULL;
        NEW.expires_at := LEAST(NEW.expires_at, NEW.created_at + interval '30 days');
        IF NEW.expires_at <= NEW.created_at THEN
          RAISE EXCEPTION 'a share link must expire in the future' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF %s THEN RETURN OLD; END IF;
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
  $f$, s, owner);

  -- Requests: the database sets the times; due 14 days after the request (spec 11.4).
  EXECUTE format($f$
    CREATE FUNCTION deletion_request_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.requested_at := clock_timestamp();
        NEW.due_at := NEW.requested_at + interval '14 days';
        NEW.cancelled_at := NULL;
        NEW.erased_at := NULL;
        NEW.identity_erased_at := NULL;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'deletion requests are kept' USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- She may cancel before erasure; erasure and the identity step are set once.
      IF ROW(NEW.id, NEW.org_id, NEW.patient_id, NEW.identity_ref, NEW.requested_at, NEW.due_at)
         IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.patient_id, OLD.identity_ref,
                              OLD.requested_at, OLD.due_at)
         OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
         OR (OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at)
         OR (OLD.identity_erased_at IS NOT NULL
             AND NEW.identity_erased_at IS DISTINCT FROM OLD.identity_erased_at)
         OR (NEW.cancelled_at IS NOT NULL AND OLD.erased_at IS NOT NULL)
         OR (NEW.identity_erased_at IS NOT NULL AND NEW.erased_at IS NULL) THEN
        RAISE EXCEPTION 'a deletion request changes only forward' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- The one erasure path (REQ-009). Runs as the schema owner, inside her organisation's scope.
  EXECUTE format($f$
    CREATE FUNCTION patient_erase(p_org uuid, p_patient uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    DECLARE
      req uuid;
    BEGIN
      PERFORM set_config('app.org_id', p_org::text, true);
      SELECT id INTO req FROM %I.deletion_request
        WHERE patient_id = p_patient AND org_id = p_org AND cancelled_at IS NULL
          AND erased_at IS NULL AND due_at <= clock_timestamp()
        FOR UPDATE;
      IF req IS NULL THEN
        RETURN false;
      END IF;
      -- Her key first: from here on, her encrypted fields are unreadable (crypto-shredding).
      INSERT INTO %I.patient_key_shredded (patient_id, org_id) VALUES (p_patient, p_org)
        ON CONFLICT (patient_id) DO NOTHING;
      DELETE FROM %I.reminder_sent WHERE patient_id = p_patient;
      DELETE FROM %I.push_subscription WHERE patient_id = p_patient;
      DELETE FROM %I.share_link WHERE patient_id = p_patient;
      DELETE FROM %I.surgery_check WHERE patient_id = p_patient;
      DELETE FROM %I.review_decision WHERE patient_id = p_patient;
      DELETE FROM %I.verdict WHERE patient_id = p_patient;
      DELETE FROM %I.red_flag_event WHERE patient_id = p_patient;
      DELETE FROM %I.check_in WHERE patient_id = p_patient;
      DELETE FROM %I.goal WHERE patient_id = p_patient;
      DELETE FROM %I.treatment_episode WHERE patient_id = p_patient;
      DELETE FROM %I.consent WHERE patient_id = p_patient;
      -- Released reservations refer to her invitation (an enrolled patient always has one).
      DELETE FROM %I.enrolment_reservation_fence
        WHERE invitation_id IN (SELECT id FROM %I.enrolment_invitation WHERE patient_id = p_patient);
      DELETE FROM %I.enrolment_invitation WHERE patient_id = p_patient;
      DELETE FROM %I.patient_record WHERE id = p_patient;
      UPDATE %I.deletion_request SET erased_at = clock_timestamp() WHERE id = req;
      RETURN true;
    END;
    $b$
  $f$, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s);

  EXECUTE format($f$
    CREATE FUNCTION deletion_due() RETURNS TABLE (patient_id uuid, org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT d.patient_id, d.org_id FROM %I.deletion_request AS d
      WHERE d.cancelled_at IS NULL AND d.erased_at IS NULL AND d.due_at <= now()
      ORDER BY d.due_at LIMIT 200
    $b$
  $f$, s, s);

  EXECUTE format($f$
    CREATE FUNCTION deletion_identity_pending() RETURNS TABLE (id uuid, org_id uuid, identity_ref uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT d.id, d.org_id, d.identity_ref FROM %I.deletion_request AS d
      WHERE d.erased_at IS NOT NULL AND d.identity_erased_at IS NULL
      ORDER BY d.erased_at LIMIT 200
    $b$
  $f$, s, s);

  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION deletion_due() OWNER TO endo_clinical_lookup;
  ALTER FUNCTION deletion_identity_pending() OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);
END;
$migration$;

CREATE TRIGGER deletion_request_guard BEFORE INSERT OR UPDATE OR DELETE ON deletion_request
  FOR EACH ROW EXECUTE FUNCTION deletion_request_guard();

REVOKE ALL ON deletion_request FROM PUBLIC;
REVOKE ALL ON FUNCTION patient_erase(uuid, uuid), deletion_due(), deletion_identity_pending()
  FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, patient_id, identity_ref) ON deletion_request TO endo_clinical_app;
GRANT UPDATE (cancelled_at, identity_erased_at) ON deletion_request TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION patient_erase(uuid, uuid), deletion_due(), deletion_identity_pending()
  TO endo_clinical_app;
