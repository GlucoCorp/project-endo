-- Wrong-code counter and lockout per invitation (ADR-0021 section 3; REQ-001, RISK-S05).
--
-- The clinician types the code shown on her phone for the invitation they selected. Wrong
-- entries are counted per invitation, shared by all its transactions and all clinicians. The
-- fifth locks the invitation for 15 minutes and cancels its transactions awaiting confirmation.
-- The database owns that policy, whatever the caller:
-- - the counter only goes up by one, and only while the invitation is not locked;
-- - the fifth wrong entry becomes the lock: the counter returns to 0 and the lock ends 15 minutes
--   later by the database clock (the caller cannot choose either);
-- - while locked, no transaction of the invitation starts or is confirmed, and at commit a lock
--   leaves none awaiting confirmation;
-- - each change has its own audit event about the invitation in the identity outbox, queued in
--   the same database transaction (section 14);
-- - starts, confirmations and code checks serialise on the invitation's guard row.
-- Opaque ids, a count and a time only.

CREATE TABLE enrolment_invitation_guard (
  invitation_id   uuid        PRIMARY KEY,
  wrong_attempts  smallint    NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 4),
  locked_until    timestamptz,
  version         integer     NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON enrolment_invitation_guard FROM PUBLIC;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- Same rule as 0003, but the cleanup of ended transactions' marks skips rows another
  -- transaction is already deleting, instead of waiting for it. Waiting there tied unrelated
  -- enrolment changes together and could close a lock cycle (a code check holding a guard row
  -- and one transaction row, an apply() holding another). The insert below is unchanged.
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION enrolment_mark_change(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      DELETE FROM enrolment_change_mark
      WHERE ctid IN (
        SELECT ctid FROM enrolment_change_mark
        WHERE xact < pg_snapshot_xmin(pg_current_snapshot())
        FOR UPDATE SKIP LOCKED
      );
      INSERT INTO enrolment_change_mark (xact, transaction_id)
      VALUES (pg_current_xact_id(), p_id) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'one enrolment change per database transaction'
          USING ERRCODE = 'check_violation';
      END IF;
    END;
    $b$
  $f$, s);

  -- A guard starts empty: nothing counted, nothing locked.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_guard_start() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NEW.wrong_attempts <> 0 OR NEW.locked_until IS NOT NULL THEN
        RAISE EXCEPTION 'an invitation guard starts empty' USING ERRCODE = 'check_violation';
      END IF;
      NEW.version := 1;
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- The only change is one more wrong entry; the fifth becomes a 15-minute lock.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_guard_count() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NEW.invitation_id <> OLD.invitation_id THEN
        RAISE EXCEPTION 'invitation guard identity is fixed' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.locked_until IS NOT NULL AND OLD.locked_until > clock_timestamp() THEN
        RAISE EXCEPTION 'invitation is locked' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.wrong_attempts <> OLD.wrong_attempts + 1
         OR NEW.locked_until IS DISTINCT FROM OLD.locked_until THEN
        RAISE EXCEPTION 'an invitation guard only counts one wrong code at a time'
          USING ERRCODE = 'check_violation';
      END IF;
      -- One change per database transaction, so each wrong entry has its own audit event.
      PERFORM enrolment_mark_change(OLD.invitation_id);
      IF NEW.wrong_attempts >= 5 THEN
        NEW.wrong_attempts := 0;
        NEW.locked_until := clock_timestamp() + interval '15 minutes';
      END IF;
      NEW.version := OLD.version + 1;
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- At commit: the change has its audit event, and a lock has left nothing awaiting
  -- confirmation. Owner's rights: the service role cannot read the outbox.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_guard_audited() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM audit_outbox AS o
        WHERE o.event->'resource'->>'id' = NEW.invitation_id::text
          AND o.xmin = pg_current_xact_id()::xid
      ) THEN
        RAISE EXCEPTION 'invitation guard change without its audit event'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.locked_until IS DISTINCT FROM OLD.locked_until AND EXISTS (
        SELECT FROM enrolment_transaction AS t
        WHERE t.invitation_id = NEW.invitation_id AND t.status = 'awaiting-confirmation'
      ) THEN
        RAISE EXCEPTION 'a locked invitation has no transaction awaiting confirmation'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $b$
  $f$, s);

  -- Starts and confirmations hold the invitation's guard row (created on first use) for the rest
  -- of their database transaction, so a concurrent code check waits for them, and they wait for
  -- it. Refused while the invitation is locked. Owner's rights, so the service role needs no
  -- direct share lock privilege beyond its own.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_guard_hold() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    DECLARE
      until timestamptz;
    BEGIN
      IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'awaiting-confirmation'
                                   AND NEW.status = 'confirmed') THEN
        RETURN NEW;
      END IF;
      INSERT INTO enrolment_invitation_guard (invitation_id) VALUES (NEW.invitation_id)
        ON CONFLICT DO NOTHING;
      SELECT g.locked_until INTO until FROM enrolment_invitation_guard AS g
        WHERE g.invitation_id = NEW.invitation_id FOR SHARE;
      IF until IS NOT NULL AND until > clock_timestamp() THEN
        RAISE EXCEPTION 'invitation is locked' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER enrolment_guard_start BEFORE INSERT ON enrolment_invitation_guard
  FOR EACH ROW EXECUTE FUNCTION enrolment_guard_start();
CREATE TRIGGER enrolment_guard_count BEFORE UPDATE ON enrolment_invitation_guard
  FOR EACH ROW EXECUTE FUNCTION enrolment_guard_count();
CREATE CONSTRAINT TRIGGER enrolment_guard_audited
  AFTER UPDATE ON enrolment_invitation_guard
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enrolment_guard_audited();
CREATE TRIGGER enrolment_transaction_hold_guard BEFORE INSERT OR UPDATE ON enrolment_transaction
  FOR EACH ROW EXECUTE FUNCTION enrolment_guard_hold();

REVOKE ALL ON FUNCTION enrolment_guard_audited() FROM PUBLIC;
REVOKE ALL ON FUNCTION enrolment_guard_hold() FROM PUBLIC;
GRANT SELECT ON enrolment_invitation_guard TO endo_identity_app;
GRANT INSERT (invitation_id) ON enrolment_invitation_guard TO endo_identity_app;
GRANT UPDATE (wrong_attempts) ON enrolment_invitation_guard TO endo_identity_app;
