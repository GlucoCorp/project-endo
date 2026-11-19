-- Idempotent episode drafting and confirmation (spec 9.1, REQ-002).
--
-- creation_key: the clinician's Idempotency-Key, kept with the draft. A retry with the same key
-- finds the same episode instead of creating a second one. Unique per prescriber, so one
-- clinician's keys never collide with another's. Fixed once set (the API role cannot update it).
--
-- confirm_key: her Idempotency-Key for the confirmation, set only together with draft -> active
-- and never changed. A retry with the same key and the same request replays; the same key with a
-- different request, or another key after confirmation, is refused (review 2026-11-15).

ALTER TABLE treatment_episode ADD COLUMN creation_key uuid NOT NULL;
ALTER TABLE treatment_episode ADD CONSTRAINT treatment_episode_creation_key
  UNIQUE (prescriber_id, creation_key);
ALTER TABLE treatment_episode ADD COLUMN confirm_key uuid;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION treatment_episode_confirm_key() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.confirm_key := NULL;
      ELSIF NEW.confirm_key IS DISTINCT FROM OLD.confirm_key
         AND NOT (OLD.status = 'draft' AND NEW.status = 'active' AND OLD.confirm_key IS NULL) THEN
        RAISE EXCEPTION 'the confirmation key is set once, when she confirms'
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'active'
         AND NEW.confirm_key IS NULL THEN
        RAISE EXCEPTION 'confirming needs her idempotency key' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER treatment_episode_confirm_key BEFORE INSERT OR UPDATE ON treatment_episode
  FOR EACH ROW EXECUTE FUNCTION treatment_episode_confirm_key();

GRANT INSERT (creation_key) ON treatment_episode TO endo_clinical_app;
GRANT UPDATE (confirm_key) ON treatment_episode TO endo_clinical_app;
