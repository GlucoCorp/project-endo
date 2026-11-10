-- At most three live transactions awaiting confirmation per invitation (ADR-0021 section 3;
-- REQ-001, RISK-S05). Without a limit, anyone holding one live link could start any number of
-- transactions with fresh browser bindings, and every start compares against all pending codes.
--
-- Redefines the guard hold from 0004. A start now takes the invitation's guard row exclusively
-- (FOR UPDATE), so concurrent starts count one after another, and is refused while the
-- invitation is locked or already has three live transactions awaiting confirmation. One past
-- its deadline does not count: the deadline sweep ends it, and it must not block new starts
-- meanwhile. Confirmations still hold the row shared, as before.

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION enrolment_guard_hold() RETURNS trigger
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
      IF TG_OP = 'INSERT' THEN
        SELECT g.locked_until INTO until FROM enrolment_invitation_guard AS g
          WHERE g.invitation_id = NEW.invitation_id FOR UPDATE;
      ELSE
        SELECT g.locked_until INTO until FROM enrolment_invitation_guard AS g
          WHERE g.invitation_id = NEW.invitation_id FOR SHARE;
      END IF;
      IF until IS NOT NULL AND until > clock_timestamp() THEN
        RAISE EXCEPTION 'invitation is locked' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'INSERT' AND (
        SELECT count(*) FROM enrolment_transaction AS t
        WHERE t.invitation_id = NEW.invitation_id
          AND t.status = 'awaiting-confirmation'
          AND t.state_deadline > clock_timestamp()
      ) >= 3 THEN
        RAISE EXCEPTION 'invitation has three transactions awaiting confirmation'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

REVOKE ALL ON FUNCTION enrolment_guard_hold() FROM PUBLIC;
