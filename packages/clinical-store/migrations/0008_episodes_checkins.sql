-- Treatment episodes, goals, weekly check-ins and red-flag events (M2: REQ-002, REQ-003, REQ-007;
-- spec 5.1, 6, 11.2). Pseudonymous: no names or contact details. Free text (her own goal) is
-- field-encrypted under her own data key (patient_key below), never stored in clear.
--
-- Treatment line (spec REQ-002 "only one active episode per treatment line"): the spec has no
-- line column. A line is a chain of episodes linked by previous_episode_id: a "switch" continues
-- the line, an "add" starts a parallel one (Section 24 item 23). line_id is the first episode's id.

-- Per-patient data keys for field encryption (spec 11.2; REQ-009 crypto-shredding). Shredding
-- writes a tombstone; the database deletes the key in the same transaction and refuses a new one.
CREATE TABLE patient_key (
  patient_id  uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  wrapped     bytea       NOT NULL CHECK (octet_length(wrapped) BETWEEN 16 AND 1024),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id)
);
CREATE TABLE patient_key_shredded (
  patient_id   uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL,
  shredded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE treatment_episode (
  id                     uuid        PRIMARY KEY,
  org_id                 uuid        NOT NULL,
  patient_id             uuid        NOT NULL,
  prescriber_id          uuid        NOT NULL,
  line_id                uuid        NOT NULL,
  previous_episode_id    uuid,
  -- Coded treatment from the clinical catalogue (clinical/treatments/), never free text.
  treatment_system       text        NOT NULL CHECK (treatment_system IN (
                           'http://www.whocc.no/atc', 'http://snomed.info/sct',
                           'http://www.nlm.nih.gov/research/umls/rxnorm',
                           'https://dmd.nhs.uk')),
  treatment_code         text        NOT NULL CHECK (treatment_code ~ '^[A-Za-z0-9.-]{1,32}$'),
  -- Which adherence question applies (spec 6.1 Q7): daily count, or still in place / given.
  adherence_mode         text        NOT NULL CHECK (adherence_mode IN ('daily', 'device_or_injection')),
  dose_text              text        NOT NULL CHECK (char_length(dose_text) BETWEEN 1 AND 120),
  start_date             date        NOT NULL,
  review_interval_weeks  smallint    NOT NULL CHECK (review_interval_weeks BETWEEN 4 AND 26),
  review_date            date        GENERATED ALWAYS AS
                           (start_date + review_interval_weeks * 7) STORED,
  -- Her IANA time zone, set when she confirms: week windows are her calendar days.
  time_zone              text        CHECK (time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$'
                                            OR time_zone = 'UTC'),
  instrument_version     text        NOT NULL CHECK (instrument_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  status                 text        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'active', 'in_review', 'closed')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  confirmed_at           timestamptz,
  closed_at              timestamptz,
  UNIQUE (id, org_id),
  UNIQUE (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  FOREIGN KEY (prescriber_id, org_id) REFERENCES clinician (id, org_id),
  FOREIGN KEY (previous_episode_id, org_id) REFERENCES treatment_episode (id, org_id),
  CHECK ((status = 'draft') = (confirmed_at IS NULL) OR status = 'closed'),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status = 'draft' OR status = 'closed' OR time_zone IS NOT NULL)
);
-- REQ-002: one active episode per treatment line.
CREATE UNIQUE INDEX treatment_episode_one_active_per_line
  ON treatment_episode (line_id) WHERE status IN ('active', 'in_review');
CREATE INDEX treatment_episode_patient_idx ON treatment_episode (patient_id, created_at DESC);

-- Her goal: a suggested template, or her own words (max 140 characters before encryption).
CREATE TABLE goal (
  id                  uuid        PRIMARY KEY,
  org_id              uuid        NOT NULL,
  patient_id          uuid        NOT NULL,
  episode_id          uuid        NOT NULL UNIQUE,
  goal_template_code  text        CHECK (goal_template_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  text_encrypted      text        CHECK (char_length(text_encrypted) BETWEEN 10 AND 2048),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  CHECK ((goal_template_code IS NULL) <> (text_encrypted IS NULL))
);

-- One check-in per episode week (spec 6, REQ-003). Answers are validated by the API against the
-- instrument version recorded with them; free-text "other" answers are not accepted in v1.
-- The database sets submitted_at and is_late, and refuses weeks outside her window.
CREATE TABLE check_in (
  id                  uuid        PRIMARY KEY,
  org_id              uuid        NOT NULL,
  patient_id          uuid        NOT NULL,
  episode_id          uuid        NOT NULL,
  week_index          smallint    NOT NULL CHECK (week_index BETWEEN 1 AND 26),
  idempotency_key     uuid        NOT NULL,
  request_hash        char(64)    NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  answers             jsonb       NOT NULL CHECK (jsonb_typeof(answers) = 'object'
                                                  AND octet_length(answers::text) <= 4096),
  instrument_version  text        NOT NULL CHECK (instrument_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  client_created_at   timestamptz NOT NULL,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  is_late             boolean     NOT NULL DEFAULT false,
  UNIQUE (episode_id, week_index),
  UNIQUE (patient_id, idempotency_key),
  UNIQUE (id, patient_id),
  FOREIGN KEY (episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id)
);

-- A red flag she reported (spec 6.3, REQ-007). Recorded on its own, before the rest of the
-- check-in, so it is never lost if she stops there. shown_at and acknowledged_at are her device's
-- times (the urgent screen works offline); recorded_at is the database's.
CREATE TABLE red_flag_event (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL,
  patient_id        uuid        NOT NULL,
  episode_id        uuid        NOT NULL,
  idempotency_key   uuid        NOT NULL,
  flags             text[]      NOT NULL CHECK (cardinality(flags) BETWEEN 1 AND 16
                                               AND array_position(flags, NULL) IS NULL),
  instrument_version text       NOT NULL CHECK (instrument_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  shown_at          timestamptz NOT NULL,
  acknowledged_at   timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  team_notified_at  timestamptz,
  UNIQUE (patient_id, idempotency_key),
  FOREIGN KEY (episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= shown_at)
);
CREATE INDEX red_flag_event_episode_idx ON red_flag_event (episode_id, recorded_at DESC);

ALTER TABLE patient_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_key FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON patient_key
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE patient_key_shredded ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_key_shredded FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON patient_key_shredded
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE treatment_episode ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatment_episode FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON treatment_episode
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE goal ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON goal
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE check_in ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_in FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON check_in
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE red_flag_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE red_flag_event FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON red_flag_event
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- Keys: serialise creation with shredding; no key after a tombstone; a tombstone deletes the key
  -- (as the owner, so the API role needs no DELETE). Row-level security still applies (FORCE).
  EXECUTE format($f$
    CREATE FUNCTION patient_key_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('patient_key:' || NEW.patient_id::text, 0));
      IF TG_TABLE_NAME = 'patient_key' THEN
        IF EXISTS (SELECT 1 FROM %I.patient_key_shredded WHERE patient_id = NEW.patient_id) THEN
          RAISE EXCEPTION 'patient key was shredded' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        DELETE FROM %I.patient_key WHERE patient_id = NEW.patient_id;
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s, s, s);

  -- Episodes: the prescription is fixed once drafted; status moves forward only.
  --   draft -> active (she confirmed, with a goal) | closed (withdrawn)
  --   active -> in_review | closed;  in_review -> active | closed;  closed is final.
  EXECUTE format($f$
    CREATE FUNCTION treatment_episode_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
          RAISE EXCEPTION 'an episode starts as a draft' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.previous_episode_id IS NULL THEN
          IF NEW.line_id <> NEW.id THEN
            RAISE EXCEPTION 'a new line starts at its own episode' USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.line_id IS DISTINCT FROM (SELECT line_id FROM %I.treatment_episode
                                             WHERE id = NEW.previous_episode_id
                                               AND patient_id = NEW.patient_id) THEN
          RAISE EXCEPTION 'a switch continues the previous episode''s line'
            USING ERRCODE = 'check_violation';
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.confirmed_at := NULL;
        NEW.closed_at := NULL;
        NEW.time_zone := NULL;
        RETURN NEW;
      END IF;
      IF ROW(NEW.id, NEW.org_id, NEW.patient_id, NEW.prescriber_id, NEW.line_id,
             NEW.previous_episode_id, NEW.treatment_system, NEW.treatment_code,
             NEW.adherence_mode, NEW.dose_text, NEW.start_date, NEW.review_interval_weeks,
             NEW.instrument_version, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.org_id, OLD.patient_id, OLD.prescriber_id, OLD.line_id,
             OLD.previous_episode_id, OLD.treatment_system, OLD.treatment_code,
             OLD.adherence_mode, OLD.dose_text, OLD.start_date, OLD.review_interval_weeks,
             OLD.instrument_version, OLD.created_at) THEN
        RAISE EXCEPTION 'an episode''s prescription cannot change' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status = 'closed' THEN
        RAISE EXCEPTION 'a closed episode is final' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.status = OLD.status THEN
        RAISE EXCEPTION 'an episode update must change its status' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.status = 'active' AND OLD.status = 'draft' THEN
        IF NOT EXISTS (SELECT 1 FROM %I.goal WHERE episode_id = NEW.id) THEN
          RAISE EXCEPTION 'an episode needs her goal before it is active'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.time_zone IS NULL THEN
          RAISE EXCEPTION 'confirming needs her time zone' USING ERRCODE = 'check_violation';
        END IF;
        NEW.confirmed_at := clock_timestamp();
      ELSIF NOT ((OLD.status = 'active' AND NEW.status IN ('in_review', 'closed'))
                 OR (OLD.status = 'in_review' AND NEW.status IN ('active', 'closed'))
                 OR (OLD.status = 'draft' AND NEW.status = 'closed')) THEN
        RAISE EXCEPTION 'episode status cannot go from %% to %%', OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      ELSE
        IF NEW.time_zone IS DISTINCT FROM OLD.time_zone THEN
          RAISE EXCEPTION 'her time zone is set when she confirms' USING ERRCODE = 'check_violation';
        END IF;
        NEW.confirmed_at := OLD.confirmed_at;
      END IF;
      NEW.closed_at := CASE WHEN NEW.status = 'closed' THEN clock_timestamp() END;
      RETURN NEW;
    END;
    $b$
  $f$, s, s, s);

  -- Goals: only while the episode is a draft, and never changed afterwards.
  EXECUTE format($f$
    CREATE FUNCTION goal_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM %I.treatment_episode
                     WHERE id = NEW.episode_id AND status = 'draft') THEN
        RAISE EXCEPTION 'a goal is set while the episode is a draft' USING ERRCODE = 'check_violation';
      END IF;
      NEW.created_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s, s);

  -- Check-ins (REQ-003). Week k covers her local days [start + 7(k-1), start + 7k). It opens on
  -- the week's last day and can be completed until 7 days after the week ends; a week past that
  -- stays missing, never imputed. It is late when submitted after the day following the week.
  EXECUTE format($f$
    CREATE FUNCTION check_in_window() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    DECLARE
      e record;
      today date;
      week_end date;
    BEGIN
      SELECT status, start_date, review_interval_weeks, time_zone, instrument_version
        INTO e FROM %I.treatment_episode WHERE id = NEW.episode_id FOR SHARE;
      IF e.status NOT IN ('active', 'in_review') THEN
        RAISE EXCEPTION 'check-ins are for an active episode' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.instrument_version <> e.instrument_version THEN
        RAISE EXCEPTION 'check-in instrument version differs from the episode''s'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.week_index > e.review_interval_weeks THEN
        RAISE EXCEPTION 'week is past the review' USING ERRCODE = 'check_violation';
      END IF;
      today := (clock_timestamp() AT TIME ZONE e.time_zone)::date;
      week_end := e.start_date + NEW.week_index * 7; -- first day after the week
      IF today < week_end - 1 THEN
        RAISE EXCEPTION 'this week''s check-in is not open yet' USING ERRCODE = 'check_violation';
      END IF;
      IF today >= week_end + 7 THEN
        RAISE EXCEPTION 'this week can no longer be completed' USING ERRCODE = 'check_violation';
      END IF;
      NEW.submitted_at := clock_timestamp();
      NEW.is_late := today > week_end;
      RETURN NEW;
    END;
    $b$
  $f$, s, s);

  EXECUTE format($f$
    CREATE FUNCTION red_flag_event_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        -- Red flags always win: recorded for any confirmed episode, even one closed since she
        -- answered offline, and never subject to the check-in window.
        IF NOT EXISTS (SELECT 1 FROM %I.treatment_episode WHERE id = NEW.episode_id
                       AND confirmed_at IS NOT NULL) THEN
          RAISE EXCEPTION 'red flags are recorded for a confirmed episode'
            USING ERRCODE = 'check_violation';
        END IF;
        NEW.recorded_at := clock_timestamp();
        NEW.team_notified_at := NULL;
        RETURN NEW;
      END IF;
      -- Only the care-team notification time may be set, once.
      IF ROW(NEW.id, NEW.org_id, NEW.patient_id, NEW.episode_id, NEW.idempotency_key, NEW.flags,
             NEW.instrument_version, NEW.shown_at, NEW.acknowledged_at, NEW.recorded_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.org_id, OLD.patient_id, OLD.episode_id, OLD.idempotency_key, OLD.flags,
             OLD.instrument_version, OLD.shown_at, OLD.acknowledged_at, OLD.recorded_at)
         OR OLD.team_notified_at IS NOT NULL OR NEW.team_notified_at IS NULL THEN
        RAISE EXCEPTION 'a red-flag event is fixed once recorded' USING ERRCODE = 'check_violation';
      END IF;
      NEW.team_notified_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s, s);

  EXECUTE format($f$
    CREATE FUNCTION m2_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      RAISE EXCEPTION '%% is append-only (%% refused)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER patient_key_guard BEFORE INSERT ON patient_key
  FOR EACH ROW EXECUTE FUNCTION patient_key_guard();
CREATE TRIGGER patient_key_shredded_guard BEFORE INSERT ON patient_key_shredded
  FOR EACH ROW EXECUTE FUNCTION patient_key_guard();
CREATE TRIGGER treatment_episode_guard BEFORE INSERT OR UPDATE ON treatment_episode
  FOR EACH ROW EXECUTE FUNCTION treatment_episode_guard();
CREATE TRIGGER goal_guard BEFORE INSERT ON goal
  FOR EACH ROW EXECUTE FUNCTION goal_guard();
CREATE TRIGGER check_in_window BEFORE INSERT ON check_in
  FOR EACH ROW EXECUTE FUNCTION check_in_window();
CREATE TRIGGER red_flag_event_guard BEFORE INSERT OR UPDATE ON red_flag_event
  FOR EACH ROW EXECUTE FUNCTION red_flag_event_guard();
CREATE TRIGGER goal_append_only BEFORE UPDATE OR DELETE ON goal
  FOR EACH ROW EXECUTE FUNCTION m2_append_only();
CREATE TRIGGER check_in_append_only BEFORE UPDATE OR DELETE ON check_in
  FOR EACH ROW EXECUTE FUNCTION m2_append_only();
CREATE TRIGGER red_flag_event_no_delete BEFORE DELETE ON red_flag_event
  FOR EACH ROW EXECUTE FUNCTION m2_append_only();
CREATE TRIGGER treatment_episode_no_delete BEFORE DELETE ON treatment_episode
  FOR EACH ROW EXECUTE FUNCTION m2_append_only();

-- Least privilege: the API inserts only the columns it chooses; the database sets times and flags.
REVOKE ALL ON patient_key, patient_key_shredded, treatment_episode, goal, check_in,
  red_flag_event FROM PUBLIC;
GRANT SELECT, INSERT (patient_id, org_id, wrapped) ON patient_key TO endo_clinical_app;
GRANT SELECT, INSERT (patient_id, org_id) ON patient_key_shredded TO endo_clinical_app;
GRANT SELECT ON treatment_episode TO endo_clinical_app;
GRANT INSERT (id, org_id, patient_id, prescriber_id, line_id, previous_episode_id,
  treatment_system, treatment_code, adherence_mode, dose_text, start_date, review_interval_weeks,
  instrument_version) ON treatment_episode TO endo_clinical_app;
GRANT UPDATE (status, time_zone) ON treatment_episode TO endo_clinical_app;
GRANT SELECT, INSERT (id, org_id, patient_id, episode_id, goal_template_code, text_encrypted)
  ON goal TO endo_clinical_app;
GRANT SELECT, INSERT (id, org_id, patient_id, episode_id, week_index, idempotency_key,
  request_hash, answers, instrument_version, client_created_at) ON check_in TO endo_clinical_app;
GRANT SELECT, INSERT (id, org_id, patient_id, episode_id, idempotency_key, flags,
  instrument_version, shown_at, acknowledged_at) ON red_flag_event TO endo_clinical_app;
GRANT UPDATE (team_notified_at) ON red_flag_event TO endo_clinical_app;
