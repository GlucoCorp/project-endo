-- The clinical store's reservation, acknowledged (ADR-0021 sections 6 and 10; REQ-001, RISK-S05).
--
-- After the clinic confirms, the coordinator reserves the invitation in the clinical store. If
-- that call times out, the outcome is unknown, and the transaction must not go on into Keycloak
-- as if the invitation were held (independent review, 2026-11-11). This table records that the
-- clinical store definitely answered "reserved for this transaction"; a handoff into Keycloak
-- needs it. The database holds the rules, whatever the caller:
-- - one row per transaction, written only while it is `confirmed`, never changed or deleted;
-- - written with its audit event in the identity outbox, in the same database transaction.

CREATE TABLE enrolment_reservation (
  transaction_id  uuid        PRIMARY KEY REFERENCES enrolment_transaction (id),
  reserved_at     timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON enrolment_reservation FROM PUBLIC;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION enrolment_reservation_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
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

  EXECUTE format($f$
    CREATE FUNCTION enrolment_reservation_audited() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM audit_outbox AS o
        WHERE o.event->'resource'->>'id' = NEW.transaction_id::text
          AND o.xmin = pg_current_xact_id()::xid
      ) THEN
        RAISE EXCEPTION 'reservation record without its audit event'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER enrolment_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON enrolment_reservation
  FOR EACH ROW EXECUTE FUNCTION enrolment_reservation_guard();
CREATE CONSTRAINT TRIGGER enrolment_reservation_audited AFTER INSERT ON enrolment_reservation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enrolment_reservation_audited();

REVOKE ALL ON FUNCTION enrolment_reservation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION enrolment_reservation_audited() FROM PUBLIC;
GRANT SELECT ON enrolment_reservation TO endo_identity_app;
GRANT INSERT (transaction_id) ON enrolment_reservation TO endo_identity_app;
