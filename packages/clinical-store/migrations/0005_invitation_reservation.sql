-- Invitation reservation: the single place where enrolment actions are ordered (ADR-0021
-- section 6; REQ-001, RISK-S04).
--
-- The identity service coordinates each enrolment as one transaction. When the clinician confirms
-- the patient in person, the coordinator reserves the invitation for that transaction. Every later
-- mutation is one conditional update on this row, so competing actions are ordered by the row lock:
--
--   reserve  live, not expired, unreserved            reserved_by := transaction
--   release  reserved, not final                      reserved_by := NULL
--   revoke   not final (reserved or not)              revoked_at  := now   (final)
--   claim    live, not expired, reserved              claimed_at  := now   (final)
--
-- The application matches reserved_by to its own transaction in the WHERE clause. This trigger
-- adds the rules that hold whatever the caller: a claim needs a reservation and keeps it, a
-- reservation never passes directly from one transaction to another, and times come from the
-- database clock. Final rows never change (unchanged from 0001).
--
-- A release is permanent for its transaction. It records a fence, and a fenced transaction can
-- never reserve again, so a delayed reserve or claim retry that arrives after cleanup began cannot
-- succeed. This holds even if the release arrives before the reserve.

ALTER TABLE enrolment_invitation
  ADD COLUMN reserved_by uuid,
  ADD COLUMN reserved_at timestamptz,
  ADD CONSTRAINT enrolment_invitation_reservation_pair
    CHECK ((reserved_by IS NULL) = (reserved_at IS NULL)),
  -- Every claim is reserved. No claim API existed before this migration and no production data
  -- exists yet, so no claimed row predates it.
  ADD CONSTRAINT enrolment_invitation_claim_reserved
    CHECK (claimed_at IS NULL OR reserved_by IS NOT NULL);

CREATE TABLE enrolment_reservation_fence (
  transaction_id uuid        PRIMARY KEY,
  org_id         uuid        NOT NULL REFERENCES organization (id),
  invitation_id  uuid        NOT NULL REFERENCES enrolment_invitation (id),
  released_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE enrolment_reservation_fence ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrolment_reservation_fence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON enrolment_reservation_fence
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION enrolment_invitation_transition() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF OLD.claimed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'enrolment invitation is final' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.claimed_at IS NOT NULL THEN
        IF OLD.expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION 'enrolment invitation expired' USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.reserved_by IS NULL OR NEW.reserved_by IS DISTINCT FROM OLD.reserved_by THEN
          RAISE EXCEPTION 'enrolment invitation claim needs its reservation'
            USING ERRCODE = 'check_violation';
        END IF;
        NEW.reserved_at := OLD.reserved_at;
        NEW.claimed_at := clock_timestamp();
      ELSIF NEW.revoked_at IS NOT NULL THEN
        -- A revocation wins over a reservation; the reservation is kept as a record of who held it.
        NEW.reserved_by := OLD.reserved_by;
        NEW.reserved_at := OLD.reserved_at;
        NEW.revoked_at := clock_timestamp();
      ELSIF OLD.reserved_by IS NULL AND NEW.reserved_by IS NOT NULL THEN
        IF OLD.expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION 'enrolment invitation expired' USING ERRCODE = 'check_violation';
        END IF;
        -- Runs as the caller, so row-level security limits this to the invitation's organisation,
        -- which is where its fences are.
        IF EXISTS (SELECT FROM enrolment_reservation_fence AS f
                   WHERE f.transaction_id = NEW.reserved_by) THEN
          RAISE EXCEPTION 'enrolment transaction was released' USING ERRCODE = 'check_violation';
        END IF;
        NEW.reserved_at := clock_timestamp();
      ELSIF OLD.reserved_by IS NOT NULL AND NEW.reserved_by IS NULL THEN
        NEW.reserved_at := NULL;
      ELSE
        RAISE EXCEPTION 'enrolment invitation update must reserve, release, claim or revoke'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- Same lookup as 0001, now also saying whether the invitation is reserved, so a new start on a
  -- reserved invitation can be refused (ADR-0021 section 6). Ownership is unchanged.
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION enrolment_find_live(p_token_hash char(64)) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT jsonb_build_object('invitation_id', i.id, 'org_id', i.org_id,
                                'reserved', i.reserved_by IS NOT NULL)
      FROM %I.enrolment_invitation AS i
      WHERE i.token_hash = p_token_hash
        AND i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    $b$
  $f$, s, s);
END;
$migration$;

GRANT SELECT (reserved_by) ON enrolment_invitation TO endo_clinical_lookup;
GRANT UPDATE (reserved_by, reserved_at) ON enrolment_invitation TO endo_clinical_app;
REVOKE ALL ON enrolment_reservation_fence FROM PUBLIC;
GRANT SELECT, INSERT (transaction_id, org_id, invitation_id) ON enrolment_reservation_fence
  TO endo_clinical_app;
