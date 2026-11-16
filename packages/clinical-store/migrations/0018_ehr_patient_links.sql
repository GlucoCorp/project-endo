-- SMART App Launch patient links (M7; spec 16.2: "the record system's patient ID is mapped to our
-- pseudonymous record through an explicit link ..., never by name or date-of-birth matching").
--
-- A clinician links a record-system patient to one of the organisation's patients once, from a
-- launch. Only SHA-256(issuer | record-system patient id) is stored: the record system's
-- identifier itself never enters the clinical database. One link per record-system patient per
-- organisation; patient_erase removes her links with the rest of her rows.

CREATE TABLE ehr_patient_link (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  link_hash   char(64)    NOT NULL CHECK (link_hash ~ '^[0-9a-f]{64}$'),
  patient_id  uuid        NOT NULL,
  created_by  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, link_hash),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  FOREIGN KEY (created_by, org_id) REFERENCES clinician (id, org_id)
);
CREATE INDEX ehr_patient_link_patient_idx ON ehr_patient_link (patient_id);

ALTER TABLE ehr_patient_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE ehr_patient_link FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ehr_patient_link
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

-- Erasure (REQ-009) removes her links too: patient_erase (migration 0014) is redefined with them.
DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION patient_erase(p_org uuid, p_patient uuid) RETURNS boolean
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
      DELETE FROM %I.ehr_patient_link WHERE patient_id = p_patient;
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
  $f$, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s);
END
$migration$;

REVOKE ALL ON ehr_patient_link FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, link_hash, patient_id, created_by) ON ehr_patient_link
  TO endo_clinical_app;
