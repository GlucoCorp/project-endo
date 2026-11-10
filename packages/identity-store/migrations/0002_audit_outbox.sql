-- Identity audit outbox (spec 2.6; ADR-0021 sections 1 and 14). The identity service coordinates
-- enrolment, and every enrolment transition is written together with its audit event, in the same
-- transaction, here. A relay then publishes the events to the audit store.
--
-- Same rules as the clinical outbox (clinical 0002 and 0003):
-- - the service can only add events; it cannot read, change or delete them;
-- - only the relay role (endo_identity_relay) reads and acknowledges them;
-- - an event never changes, is published once (by the database clock), and failures are counted
--   one at a time, so a bad event is set aside after five attempts instead of blocking the rest.
-- Events carry opaque ids and codes only, never identity fields, codes, tokens or secrets.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_identity_relay') THEN
    RAISE EXCEPTION 'endo_identity_relay missing: run packages/identity-store/bootstrap/roles.sql first';
  END IF;
  IF pg_has_role('endo_identity_app', 'endo_identity_relay', 'MEMBER') THEN
    RAISE EXCEPTION 'endo_identity_app must not be a member of endo_identity_relay';
  END IF;
END;
$$;

CREATE TABLE audit_outbox (
  id            uuid        PRIMARY KEY,
  seq           bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  event         jsonb       NOT NULL CHECK (jsonb_typeof(event) = 'object'
                  AND octet_length(event::text) <= 4096),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      smallint    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text        CHECK (last_error IS NULL OR (char_length(last_error) <= 64
                  AND last_error ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'))
);
CREATE INDEX audit_outbox_pending_idx ON audit_outbox (seq)
  WHERE published_at IS NULL AND attempts < 5;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION audit_outbox_publish_once() RETURNS trigger
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
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO endo_identity_relay', s);
END;
$migration$;

CREATE TRIGGER audit_outbox_forward_only BEFORE UPDATE ON audit_outbox
  FOR EACH ROW EXECUTE FUNCTION audit_outbox_publish_once();

REVOKE ALL ON audit_outbox FROM PUBLIC;
GRANT INSERT (id, event) ON audit_outbox TO endo_identity_app;
GRANT SELECT ON audit_outbox TO endo_identity_relay;
GRANT UPDATE (published_at, attempts, last_error) ON audit_outbox TO endo_identity_relay;
