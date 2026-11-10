-- Publishing an audit outbox event keeps its failure record (spec 2.6; RISK-R01).
--
-- The 0003 trigger checked the failure counter only on failure updates. The relay role could
-- publish an event while resetting `attempts` and `last_error` in the same UPDATE, erasing the
-- record of failed deliveries. This replaces the function: publishing must leave both unchanged.

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION audit_outbox_publish_once() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF OLD.published_at IS NOT NULL OR NEW.event IS DISTINCT FROM OLD.event
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'audit_outbox rows are published once and never changed'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.published_at IS NOT NULL THEN
        -- Publishing keeps the failure record exactly as it was.
        IF NEW.attempts <> OLD.attempts OR NEW.last_error IS DISTINCT FROM OLD.last_error THEN
          RAISE EXCEPTION 'audit_outbox publishing cannot change the failure record'
            USING ERRCODE = 'check_violation';
        END IF;
        NEW.published_at := clock_timestamp();
      ELSIF NEW.attempts <> OLD.attempts + 1 THEN
        RAISE EXCEPTION 'audit_outbox failures are counted one at a time'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;
