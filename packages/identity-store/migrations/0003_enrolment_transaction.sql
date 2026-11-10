-- Enrolment transactions (ADR-0021 sections 1, 3, 10, 14; REQ-001, RISK-S04, RISK-S05).
--
-- The identity service coordinates each patient enrolment as one transaction. Its pure state
-- machine (services/identity/src/enrolment/state-machine.ts) decides every transition; this table
-- keeps the result and refuses anything that machine could never produce, whatever the caller:
-- - only the transitions of the ADR-0021 section 10 table; terminal states never change;
-- - the transaction's identity (invitation, organisation, start, absolute deadline, browser
--   binding) never changes;
-- - a deadline in every pre-claim state, never past the absolute deadline, and changed only
--   by a transition;
-- - decisions and claim ids set only on consent, in full, and never again; the provisional
--   subject set only on redemption; cancellation reasons written once;
-- - activation steps one at a time, and `active` only after all three;
-- - one change per row per database transaction, each with its own audit event in the identity
--   outbox, in the same database transaction (section 14);
-- - `version` and `updated_at` set by the database.
-- No identity data is stored here: opaque ids, a SHA-256 of the browser secret, the code's MAC
-- under its own wrapped key, and her consent decisions until activation writes them.

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- Her four decisions, exactly: {purpose: {status, version, decided_at}}.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_decisions_valid(d jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE SET search_path = %I, pg_temp AS $b$
      SELECT coalesce(
        jsonb_typeof(d) = 'object'
        AND octet_length(d::text) <= 2048
        AND d ?& ARRAY['self_tracking', 'share_with_care_team', 'research_deidentified',
                       'org_aggregate_reporting']
        AND (SELECT count(*) FROM jsonb_object_keys(d)) = 4
        AND (SELECT bool_and(coalesce(
               jsonb_typeof(v) = 'object'
               AND (SELECT count(*) FROM jsonb_object_keys(v)) = 3
               AND v->>'status' IN ('granted', 'declined')
               AND jsonb_typeof(v->'version') = 'number'
               AND (v->>'version') ~ '^[1-9][0-9]{0,8}$'
               AND jsonb_typeof(v->'decided_at') = 'string'
               AND (v->>'decided_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$',
             false))
             FROM jsonb_each(d) AS e(k, v)),
        false)
    $b$
  $f$, s);
END;
$migration$;

CREATE TABLE enrolment_transaction (
  id                   uuid        PRIMARY KEY,
  invitation_id        uuid        NOT NULL,
  org_id               uuid        NOT NULL,
  status               text        NOT NULL CHECK (status IN ('awaiting-confirmation', 'confirmed',
                         'redeemed', 'credential-committed', 'consent-pending', 'claiming',
                         'activating', 'active', 'cancelling', 'cancelled')),
  started_at           timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,
  state_deadline       timestamptz,
  -- SHA-256 hex of the 256-bit browser secret (ADR-0021 section 4); the secret is never stored.
  binding_hash         char(64)    NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  -- The confirmation code's MAC and its kms/identity data key (section 3); cleared once the
  -- transaction leaves awaiting-confirmation.
  code_wrapped_key     text        CHECK (char_length(code_wrapped_key) <= 1024),
  code_mac             text        CHECK (char_length(code_mac) <= 128),
  provisional_subject  text        CHECK (char_length(provisional_subject) BETWEEN 1 AND 255),
  decisions            jsonb       CHECK (decisions IS NULL OR enrolment_decisions_valid(decisions)),
  person_id            uuid,
  patient_id           uuid,
  cancel_requested     text        CHECK (cancel_requested IN ('deadline', 'patient-cancelled',
                         'clinician-revoked', 'declined', 'code-lockout', 'sibling-confirmed',
                         'claim-refused')),
  cancel_reason        text        CHECK (cancel_reason IN ('deadline', 'patient-cancelled',
                         'clinician-revoked', 'declined', 'code-lockout', 'sibling-confirmed',
                         'claim-refused')),
  activation_step      smallint    NOT NULL DEFAULT 0 CHECK (activation_step BETWEEN 0 AND 3),
  version              integer     NOT NULL DEFAULT 1,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '60 minutes'),
  -- A deadline exactly in the pre-claim states, never past the absolute deadline.
  CHECK ((status IN ('awaiting-confirmation', 'confirmed', 'redeemed', 'credential-committed',
           'consent-pending')) = (state_deadline IS NOT NULL)),
  CHECK (state_deadline IS NULL OR state_deadline <= expires_at),
  CHECK ((code_wrapped_key IS NULL) = (code_mac IS NULL)),
  CHECK ((status = 'awaiting-confirmation') = (code_mac IS NOT NULL)),
  CHECK (status NOT IN ('claiming', 'activating', 'active')
         OR (decisions IS NOT NULL AND person_id IS NOT NULL AND patient_id IS NOT NULL)),
  CHECK ((status IN ('cancelling', 'cancelled')) = (cancel_reason IS NOT NULL)),
  CHECK (cancel_requested IS NULL OR status = 'claiming'),
  CHECK (status IN ('activating', 'active') OR activation_step = 0),
  CHECK ((status = 'active') = (activation_step = 3))
);

-- One row per enrolment change in the current database transaction (see the guard below). Only
-- the owner's functions write it; the service role has no privileges on it. Rows are removed at
-- commit by the audit check, and vanish with a rollback.
CREATE TABLE enrolment_change_mark (
  xact            xid8 NOT NULL,
  transaction_id  uuid NOT NULL,
  PRIMARY KEY (xact, transaction_id)
);
REVOKE ALL ON enrolment_change_mark FROM PUBLIC;

CREATE INDEX enrolment_transaction_invitation_idx ON enrolment_transaction (invitation_id)
  WHERE status NOT IN ('active', 'cancelled');
CREATE INDEX enrolment_transaction_binding_idx ON enrolment_transaction (binding_hash);
-- For the deadline sweep: open pre-claim transactions by deadline.
CREATE INDEX enrolment_transaction_deadline_idx ON enrolment_transaction (state_deadline)
  WHERE state_deadline IS NOT NULL;
-- For the audit check below: outbox events by the resource they describe.
CREATE INDEX audit_outbox_resource_idx ON audit_outbox ((event->'resource'->>'id'));

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- Records one change of an enrolment transaction in this database transaction, and refuses a
  -- second (savepoints included: the mark rolls back with its change).
  EXECUTE format($f$
    CREATE FUNCTION enrolment_mark_change(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      INSERT INTO enrolment_change_mark (xact, transaction_id)
      VALUES (pg_current_xact_id(), p_id) ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'one enrolment change per database transaction'
          USING ERRCODE = 'check_violation';
      END IF;
    END;
    $b$
  $f$, s);

  -- Every transaction starts awaiting confirmation, at (about) the database's own time.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_transaction_start() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NEW.status <> 'awaiting-confirmation' THEN
        RAISE EXCEPTION 'an enrolment transaction starts awaiting confirmation'
          USING ERRCODE = 'check_violation';
      END IF;
      IF abs(extract(epoch FROM NEW.started_at - clock_timestamp())) > 60 THEN
        RAISE EXCEPTION 'enrolment transaction start time is not now'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.state_deadline > NEW.started_at + interval '15 minutes' THEN
        RAISE EXCEPTION 'enrolment deadline cannot be moved' USING ERRCODE = 'check_violation';
      END IF;
      PERFORM enrolment_mark_change(NEW.id);
      NEW.version := 1;
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  EXECUTE format($f$
    CREATE FUNCTION enrolment_transaction_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.invitation_id <> OLD.invitation_id OR NEW.org_id <> OLD.org_id
         OR NEW.started_at <> OLD.started_at OR NEW.expires_at <> OLD.expires_at
         OR NEW.binding_hash <> OLD.binding_hash THEN
        RAISE EXCEPTION 'enrolment transaction identity is fixed' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status IN ('active', 'cancelled') THEN
        RAISE EXCEPTION 'enrolment transaction is final' USING ERRCODE = 'check_violation';
      END IF;
      -- One change per database transaction, so every change has its own audit event.
      PERFORM enrolment_mark_change(OLD.id);
      IF NOT (
        (OLD.status, NEW.status) IN (
          ('awaiting-confirmation', 'confirmed'), ('awaiting-confirmation', 'cancelling'),
          ('confirmed', 'redeemed'), ('confirmed', 'cancelling'),
          ('redeemed', 'credential-committed'), ('redeemed', 'consent-pending'),
          ('redeemed', 'cancelling'),
          ('credential-committed', 'consent-pending'), ('credential-committed', 'cancelling'),
          ('consent-pending', 'claiming'), ('consent-pending', 'cancelling'),
          ('claiming', 'claiming'), ('claiming', 'activating'), ('claiming', 'cancelling'),
          ('activating', 'activating'), ('activating', 'active'),
          ('cancelling', 'cancelled'))
      ) THEN
        RAISE EXCEPTION 'enrolment transition %% -> %% is not allowed', OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;

      -- Deadlines change only with a transition into a pre-claim state, at most 30 minutes ahead
      -- (plus two minutes of tolerance for the service clock running ahead of this one).
      IF NEW.state_deadline IS DISTINCT FROM OLD.state_deadline AND NEW.state_deadline IS NOT NULL
         AND (NEW.status = OLD.status
              OR NEW.state_deadline > clock_timestamp() + interval '32 minutes') THEN
        RAISE EXCEPTION 'enrolment deadline cannot be moved' USING ERRCODE = 'check_violation';
      END IF;

      -- Written once, at their own step.
      IF NEW.provisional_subject IS DISTINCT FROM OLD.provisional_subject
         AND NOT (OLD.status = 'confirmed' AND NEW.status = 'redeemed'
                  AND OLD.provisional_subject IS NULL) THEN
        RAISE EXCEPTION 'enrolment provisional subject is written once, at redemption'
          USING ERRCODE = 'check_violation';
      END IF;
      IF (NEW.decisions IS DISTINCT FROM OLD.decisions
          OR NEW.person_id IS DISTINCT FROM OLD.person_id
          OR NEW.patient_id IS DISTINCT FROM OLD.patient_id)
         AND NOT (OLD.status = 'consent-pending' AND NEW.status = 'claiming'
                  AND OLD.decisions IS NULL AND OLD.person_id IS NULL
                  AND OLD.patient_id IS NULL) THEN
        RAISE EXCEPTION 'enrolment decisions and claim ids are written once, at consent'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.cancel_reason IS NOT NULL AND NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
        RAISE EXCEPTION 'enrolment cancellation reason is written once'
          USING ERRCODE = 'check_violation';
      END IF;
      -- A cancel request is set once during claiming and cleared only by leaving claiming.
      IF NEW.cancel_requested IS DISTINCT FROM OLD.cancel_requested
         AND NOT ((OLD.cancel_requested IS NULL AND NEW.status = 'claiming')
                  OR (NEW.cancel_requested IS NULL AND NEW.status <> 'claiming')) THEN
        RAISE EXCEPTION 'enrolment cancel request is written once'
          USING ERRCODE = 'check_violation';
      END IF;

      -- Activation: one step at a time, only while activating; active needs all three.
      IF NEW.activation_step <> OLD.activation_step
         AND NOT (OLD.status = 'activating' AND NEW.activation_step = OLD.activation_step + 1) THEN
        RAISE EXCEPTION 'enrolment activation steps move forward one at a time'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.status = 'active' AND OLD.activation_step <> 2 THEN
        RAISE EXCEPTION 'enrolment is active only after every activation step'
          USING ERRCODE = 'check_violation';
      END IF;

      NEW.version := OLD.version + 1;
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- At commit: every insert or update of a transaction has an audit event about it, queued in
  -- the same database transaction (ADR-0021 section 14). Only events queued by the top-level
  -- transaction count, so an event inside a savepoint is refused (the strict side). Runs with the owner's rights, because
  -- the service role cannot read the outbox.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_transaction_audited() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM audit_outbox AS o
        WHERE o.event->'resource'->>'id' = NEW.id::text
          AND o.xmin = pg_current_xact_id()::xid
      ) THEN
        RAISE EXCEPTION 'enrolment change without its audit event'
          USING ERRCODE = 'check_violation';
      END IF;
      DELETE FROM enrolment_change_mark
        WHERE xact = pg_current_xact_id() AND transaction_id = NEW.id;
      RETURN NULL;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER enrolment_transaction_start BEFORE INSERT ON enrolment_transaction
  FOR EACH ROW EXECUTE FUNCTION enrolment_transaction_start();
CREATE TRIGGER enrolment_transaction_guard BEFORE UPDATE ON enrolment_transaction
  FOR EACH ROW EXECUTE FUNCTION enrolment_transaction_guard();
CREATE CONSTRAINT TRIGGER enrolment_transaction_audited
  AFTER INSERT OR UPDATE ON enrolment_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enrolment_transaction_audited();

REVOKE ALL ON enrolment_transaction FROM PUBLIC;
REVOKE ALL ON FUNCTION enrolment_transaction_audited() FROM PUBLIC;
-- The triggers call it with the caller's rights; calling it directly only adds a mark (stricter).
REVOKE ALL ON FUNCTION enrolment_mark_change(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enrolment_mark_change(uuid) TO endo_identity_app;
GRANT SELECT ON enrolment_transaction TO endo_identity_app;
GRANT INSERT (id, invitation_id, org_id, status, started_at, expires_at, state_deadline,
  binding_hash, code_wrapped_key, code_mac) ON enrolment_transaction TO endo_identity_app;
GRANT UPDATE (status, state_deadline, code_wrapped_key, code_mac, provisional_subject, decisions,
  person_id, patient_id, cancel_requested, cancel_reason, activation_step)
  ON enrolment_transaction TO endo_identity_app;
