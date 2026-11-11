-- When she actually chose (spec 13.1; ADR-0021 section 10; REQ-001).
--
-- `decided_at` stays the database's own time of recording. At enrolment her four decisions are
-- made on her phone before activation records them, so the coordinator also passes the time she
-- chose each one. It is kept apart, in `chosen_at`, and the database bounds it: never after the
-- recording time and at most two hours before it (an enrolment lasts at most 60 minutes, plus
-- clock tolerance). Decisions made later, in settings, have no `chosen_at`.

ALTER TABLE consent ADD COLUMN chosen_at timestamptz;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION consent_chosen_at_bounds() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      -- Runs after consent_order (trigger names sort), so decided_at is the database's time.
      IF NEW.chosen_at IS NOT NULL
         AND (NEW.chosen_at > NEW.decided_at + interval '2 minutes'
              OR NEW.chosen_at < NEW.decided_at - interval '2 hours') THEN
        RAISE EXCEPTION 'consent chosen_at must be shortly before it is recorded'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER consent_order_z_chosen_at BEFORE INSERT ON consent
  FOR EACH ROW EXECUTE FUNCTION consent_chosen_at_bounds();

GRANT INSERT (chosen_at) ON consent TO endo_clinical_app;
