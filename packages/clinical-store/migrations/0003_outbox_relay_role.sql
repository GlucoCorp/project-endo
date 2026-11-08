-- Fixes from the security review of 0002 (spec 2.6, 9.1; ADR-0017). 0002 is merged and therefore
-- immutable (ADR-0013), so the changes come as this migration.
--
-- 1. The API role could read the outbox and mark pending events published without delivering
--    them. Now the API may only add events; a separate relay role reads and acknowledges them.
-- 2. A failing event could block the relay forever. Failures are counted with a safe code, and an
--    event is set aside after 5 attempts.
-- 3. The retention job (M6) clears a sealed response but keeps its row as a tombstone, so an
--    Idempotency-Key can never create twice. The response columns therefore become nullable.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_relay') THEN
    RAISE EXCEPTION 'endo_clinical_relay missing: run packages/clinical-store/bootstrap/roles.sql first';
  END IF;
END;
$$;

ALTER TABLE idempotency_record ALTER COLUMN response_wrapped_key DROP NOT NULL;
ALTER TABLE idempotency_record ALTER COLUMN response_envelope DROP NOT NULL;
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_tombstone_check
  CHECK ((response_wrapped_key IS NULL) = (response_envelope IS NULL));

ALTER TABLE audit_outbox ADD COLUMN attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE audit_outbox ADD COLUMN last_error text CHECK (last_error IS NULL OR (
  char_length(last_error) <= 64 AND last_error ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'));
DROP INDEX audit_outbox_pending_idx;
CREATE INDEX audit_outbox_pending_idx ON audit_outbox (seq)
  WHERE published_at IS NULL AND attempts < 5;

-- Events and their times never change; publishing happens once; failures count one at a time.
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
        NEW.published_at := clock_timestamp();
      ELSIF NEW.attempts <> OLD.attempts + 1 THEN
        RAISE EXCEPTION 'audit_outbox failures are counted one at a time'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO endo_clinical_relay', s);
END;
$migration$;

-- The API adds events and nothing else: it cannot read, acknowledge or hide them.
REVOKE SELECT, UPDATE ON audit_outbox FROM endo_clinical_app;
GRANT SELECT ON audit_outbox TO endo_clinical_relay;
GRANT UPDATE (published_at, attempts, last_error) ON audit_outbox TO endo_clinical_relay;
