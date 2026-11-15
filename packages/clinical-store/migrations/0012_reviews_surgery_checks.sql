-- Clinician review decisions and pre-surgery checks (M4: REQ-005, REQ-006; spec 5.1, 21.8).
--
-- review_decision: one per reviewed episode, recorded with the episode's closing in the same
-- transaction (a decision is required to close a review). The clinician's note is free text,
-- encrypted under the patient's own key. Append-only.
-- surgery_check: the snapshot the clinician saw (treatments and how far each was tried, from the
-- record), the procedure considered, and the acknowledgement. Visible to her too. Append-only.

CREATE TABLE review_decision (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL,
  patient_id       uuid        NOT NULL,
  episode_id       uuid        NOT NULL UNIQUE,
  verdict_id       uuid        REFERENCES verdict (id),
  clinician_id     uuid        NOT NULL,
  decision_code    text        NOT NULL CHECK (decision_code IN ('continue', 'switch', 'add', 'refer', 'stop')),
  note_encrypted   text        CHECK (char_length(note_encrypted) BETWEEN 10 AND 8192),
  next_episode_id  uuid,
  added_episode_id uuid,
  idempotency_key  uuid        NOT NULL,
  request_hash     char(64)    NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinician_id, idempotency_key),
  FOREIGN KEY (episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  FOREIGN KEY (clinician_id, org_id) REFERENCES clinician (id, org_id),
  FOREIGN KEY (next_episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (added_episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  -- Continue and switch open the next episode in the line; add also opens a new line.
  CHECK ((decision_code IN ('continue', 'switch', 'add')) = (next_episode_id IS NOT NULL)),
  CHECK ((decision_code = 'add') = (added_episode_id IS NOT NULL))
);

CREATE TABLE surgery_check (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL,
  patient_id       uuid        NOT NULL,
  clinician_id     uuid        NOT NULL,
  procedure_code   text        NOT NULL CHECK (procedure_code IN ('hysterectomy', 'myomectomy',
                     'ovarian_cystectomy', 'adenomyomectomy', 'ablation')),
  snapshot         jsonb       NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'
                                               AND octet_length(snapshot::text) <= 32768),
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  idempotency_key  uuid        NOT NULL,
  UNIQUE (clinician_id, idempotency_key),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  FOREIGN KEY (clinician_id, org_id) REFERENCES clinician (id, org_id)
);
CREATE INDEX surgery_check_patient_idx ON surgery_check (patient_id, acknowledged_at DESC);

ALTER TABLE review_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON review_decision
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE surgery_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE surgery_check FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON surgery_check
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- A decision closes an open episode (active or in review): never a draft or a closed one.
  EXECUTE format($f$
    CREATE FUNCTION review_decision_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
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
  $f$, s, s);

  EXECUTE format($f$
    CREATE FUNCTION surgery_check_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'pre-surgery checks are append-only (%% refused)', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.acknowledged_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER review_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON review_decision
  FOR EACH ROW EXECUTE FUNCTION review_decision_guard();
CREATE TRIGGER surgery_check_guard BEFORE INSERT OR UPDATE OR DELETE ON surgery_check
  FOR EACH ROW EXECUTE FUNCTION surgery_check_guard();

REVOKE ALL ON review_decision, surgery_check FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, patient_id, episode_id, verdict_id, clinician_id, decision_code,
  note_encrypted, next_episode_id, added_episode_id, idempotency_key, request_hash)
  ON review_decision TO endo_clinical_app;
GRANT SELECT, INSERT (id, org_id, patient_id, clinician_id, procedure_code, snapshot,
  idempotency_key) ON surgery_check TO endo_clinical_app;
