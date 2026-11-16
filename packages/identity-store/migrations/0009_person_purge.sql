-- Hard deletion of an erased person (REQ-009, spec 11.4; ADR-0029, Section 24 item 38).
--
-- erase() already shredded her key and cleared her sign-in subject. person_purge() then removes
-- her rows: her enrolment transactions (they hold her provisional Keycloak subject and her
-- consent decisions) with their handoffs, reservations and change marks, and the person row,
-- which cascades to her patient links and email codes. The key tombstone (person_key_shredded)
-- stays, so her key can never be re-created.
--
-- The guards that refuse DELETE allow it only while person_purge() runs for that same person: it
-- sets the transaction-local `endo.purge_person`. The application role has no DELETE grant on
-- these tables, so the setting alone deletes nothing.

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION email_code_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.person_id IS NOT NULL
           AND current_setting('endo.purge_person', true) = OLD.person_id::text THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'email codes are not deleted' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'INSERT' THEN
        NEW.created_at := clock_timestamp();
        NEW.expires_at := NEW.created_at + interval '10 minutes';
        NEW.attempts := 0;
        NEW.used_at := NULL;
        RETURN NEW;
      END IF;
      IF (NEW.id, NEW.purpose, NEW.person_id, NEW.address_index, NEW.source_index,
          NEW.code_wrapped_key, NEW.code_mac, NEW.pending_email, NEW.created_at, NEW.expires_at)
         IS DISTINCT FROM
         (OLD.id, OLD.purpose, OLD.person_id, OLD.address_index, OLD.source_index,
          OLD.code_wrapped_key, OLD.code_mac, OLD.pending_email, OLD.created_at, OLD.expires_at)
      THEN
        RAISE EXCEPTION 'an email code request never changes' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.used_at IS NOT NULL OR OLD.attempts >= 5 OR clock_timestamp() > OLD.expires_at THEN
        RAISE EXCEPTION 'email code is final' USING ERRCODE = 'check_violation';
      END IF;
      -- One step at a time: one more wrong entry, or used once.
      IF NOT ((NEW.attempts = OLD.attempts + 1 AND NEW.used_at IS NULL)
           OR (NEW.attempts = OLD.attempts AND NEW.used_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'email code update must count one attempt or use it'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.used_at IS NOT NULL THEN
        NEW.used_at := clock_timestamp();
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION enrolment_reservation_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF EXISTS (
          SELECT FROM enrolment_transaction AS t
          WHERE t.id = OLD.transaction_id
            AND t.person_id::text = current_setting('endo.purge_person', true)
        ) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'a reservation record never changes' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a reservation record never changes' USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (
        SELECT FROM enrolment_transaction AS t
        WHERE t.id = NEW.transaction_id AND t.status = 'confirmed'
      ) THEN
        RAISE EXCEPTION 'a reservation is recorded only for a confirmed transaction'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.reserved_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- True when her rows are gone (now or before); false for a person never erased or unknown.
  EXECUTE format($f$
    CREATE FUNCTION person_purge(p_person uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    DECLARE
      v_erased boolean;
    BEGIN
      SELECT deleted_at IS NOT NULL INTO v_erased FROM person WHERE id = p_person FOR UPDATE;
      IF v_erased IS NULL THEN
        -- Already purged if her key tombstone remains; otherwise unknown.
        RETURN EXISTS (SELECT FROM person_key_shredded WHERE person_id = p_person);
      END IF;
      IF NOT v_erased THEN
        RETURN false;
      END IF;
      PERFORM set_config('endo.purge_person', p_person::text, true);
      DELETE FROM enrolment_handoff
        WHERE transaction_id IN (SELECT id FROM enrolment_transaction WHERE person_id = p_person);
      DELETE FROM enrolment_reservation
        WHERE transaction_id IN (SELECT id FROM enrolment_transaction WHERE person_id = p_person);
      DELETE FROM enrolment_change_mark
        WHERE transaction_id IN (SELECT id FROM enrolment_transaction WHERE person_id = p_person);
      DELETE FROM enrolment_transaction WHERE person_id = p_person;
      DELETE FROM person WHERE id = p_person;
      PERFORM set_config('endo.purge_person', '', true);
      RETURN true;
    END;
    $b$
  $f$, s);
END;
$migration$;

REVOKE ALL ON FUNCTION person_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_purge(uuid) TO endo_identity_app;
