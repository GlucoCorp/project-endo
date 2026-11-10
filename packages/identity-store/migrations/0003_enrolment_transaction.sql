-- Enrolment transactions (ADR-0021 sections 1, 3, 10; REQ-001, RISK-S04, RISK-S05).
--
-- The identity service coordinates each patient enrolment as one transaction. Its pure state
-- machine (services/identity/src/enrolment/state-machine.ts) decides every transition; this table
-- keeps the result, and refuses anything that machine could never produce:
-- - only the transitions of the ADR-0021 section 10 table, and terminal states never change;
-- - the transaction's identity (invitation, organisation, start, absolute deadline, browser
--   binding) never changes;
-- - `version` and `updated_at` are set by the database, so a writer cannot fake either.
-- No identity data is stored here: opaque ids, a SHA-256 of the browser secret, the code's MAC
-- under its own wrapped key, and her consent decisions until activation writes them.

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
  decisions            jsonb       CHECK (decisions IS NULL OR (jsonb_typeof(decisions) = 'object'
                         AND octet_length(decisions::text) <= 2048)),
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
  CHECK ((code_wrapped_key IS NULL) = (code_mac IS NULL)),
  CHECK (code_mac IS NULL OR status = 'awaiting-confirmation'),
  CHECK (status <> 'awaiting-confirmation' OR code_mac IS NOT NULL),
  CHECK (status NOT IN ('claiming', 'activating', 'active')
         OR (decisions IS NOT NULL AND person_id IS NOT NULL AND patient_id IS NOT NULL)),
  CHECK ((status IN ('cancelling', 'cancelled')) = (cancel_reason IS NOT NULL)),
  CHECK (cancel_requested IS NULL OR status = 'claiming')
);

CREATE INDEX enrolment_transaction_invitation_idx ON enrolment_transaction (invitation_id)
  WHERE status NOT IN ('active', 'cancelled');
CREATE INDEX enrolment_transaction_binding_idx ON enrolment_transaction (binding_hash);
-- For the deadline sweep: open pre-claim transactions by deadline.
CREATE INDEX enrolment_transaction_deadline_idx ON enrolment_transaction (state_deadline)
  WHERE state_deadline IS NOT NULL;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
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
      -- Activation steps only move forward, one at a time.
      IF NEW.activation_step < OLD.activation_step
         OR NEW.activation_step > OLD.activation_step + 1 THEN
        RAISE EXCEPTION 'enrolment activation steps move forward one at a time'
          USING ERRCODE = 'check_violation';
      END IF;
      -- Once recorded, the consent decisions and the ids generated for claiming never change.
      IF (OLD.decisions IS NOT NULL AND NEW.decisions IS DISTINCT FROM OLD.decisions)
         OR (OLD.person_id IS NOT NULL AND NEW.person_id IS DISTINCT FROM OLD.person_id)
         OR (OLD.patient_id IS NOT NULL AND NEW.patient_id IS DISTINCT FROM OLD.patient_id)
         OR (OLD.provisional_subject IS NOT NULL
             AND NEW.provisional_subject IS DISTINCT FROM OLD.provisional_subject) THEN
        RAISE EXCEPTION 'enrolment transaction records are written once'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.version := OLD.version + 1;
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
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
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER enrolment_transaction_start BEFORE INSERT ON enrolment_transaction
  FOR EACH ROW EXECUTE FUNCTION enrolment_transaction_start();
CREATE TRIGGER enrolment_transaction_guard BEFORE UPDATE ON enrolment_transaction
  FOR EACH ROW EXECUTE FUNCTION enrolment_transaction_guard();

REVOKE ALL ON enrolment_transaction FROM PUBLIC;
GRANT SELECT ON enrolment_transaction TO endo_identity_app;
GRANT INSERT (id, invitation_id, org_id, status, started_at, expires_at, state_deadline,
  binding_hash, code_wrapped_key, code_mac) ON enrolment_transaction TO endo_identity_app;
GRANT UPDATE (status, state_deadline, code_wrapped_key, code_mac, provisional_subject, decisions,
  person_id, patient_id, cancel_requested, cancel_reason, activation_step)
  ON enrolment_transaction TO endo_identity_app;
