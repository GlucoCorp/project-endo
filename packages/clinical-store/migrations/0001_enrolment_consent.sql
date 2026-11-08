-- Clinical store, M1 slice: organisations, clinicians, pseudonymous patient records, enrolment
-- invitations and consent decisions (spec 4 REQ-001, 5.1, 10.4, 13.1; ADR-0017).
-- No names, emails, phones or addresses here (spec 5.1): identity lives in the identity vault and
-- is referenced only by the opaque identity_ref.
--
-- Organisation isolation is enforced twice: by authz in the API, and here by row-level security
-- on app.org_id, which the API sets per transaction (spec 10.4). With app.org_id unset, every
-- policy matches nothing. RLS protects against a missing tenant filter; the API remains trusted
-- to choose the authorised organisation.
--
-- Runs as the database owner (no superuser, no CREATEROLE). Roles come from bootstrap/roles.sql.
-- Every function pins search_path to this schema with pg_temp last, so temporary objects can
-- never shadow the tables, sequences or functions it uses.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_app')
     OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_lookup') THEN
    RAISE EXCEPTION 'clinical roles missing: run packages/clinical-store/bootstrap/roles.sql first';
  END IF;
  IF pg_has_role('endo_clinical_app', 'endo_clinical_lookup', 'MEMBER') THEN
    RAISE EXCEPTION 'endo_clinical_app must not be a member of endo_clinical_lookup';
  END IF;
END;
$$;

CREATE FUNCTION endo_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

CREATE TABLE organization (
  id          uuid        PRIMARY KEY,
  region      text        NOT NULL CHECK (region ~ '^[a-z]{2}(-[a-z0-9]+)*$'),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- identity_ref is unique per organisation only: a global constraint would let one organisation
-- learn, from a conflict, that a reference exists in another.
CREATE TABLE clinician (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL REFERENCES organization (id),
  identity_ref  uuid        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('clinician', 'org_admin')),
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, identity_ref)
);

CREATE TABLE patient_record (
  id                  uuid        PRIMARY KEY,
  org_id              uuid        NOT NULL REFERENCES organization (id),
  identity_ref        uuid        NOT NULL,
  birth_year          smallint    CHECK (birth_year BETWEEN 1900 AND 2100),
  preferred_language  text        CHECK (preferred_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, identity_ref)
);

-- Only the SHA-256 of the link token is stored; the token itself exists only in the link. The
-- token is 256 random bits, so the global uniqueness of its hash reveals nothing useful.
CREATE TABLE enrolment_invitation (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES organization (id),
  created_by   uuid        NOT NULL,
  token_hash   char(64)    NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  claimed_at   timestamptz,
  patient_id   uuid,
  revoked_at   timestamptz,
  FOREIGN KEY (created_by, org_id) REFERENCES clinician (id, org_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  -- REQ-001: valid at most 7 days. created_at is set by the database, never by the API.
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((claimed_at IS NULL) = (patient_id IS NULL)),
  CHECK (claimed_at IS NULL OR revoked_at IS NULL)
);

-- One row per decision, never updated or deleted by the application. The current state of a
-- purpose is the row with the highest seq, which the database assigns after taking a lock per
-- patient and purpose, so commit order and seq order agree and a withdrawal always wins over an
-- earlier grant. decided_at is set by the database. 'declined' is recorded at enrolment when she
-- says no (REQ-001); 'revoked' is a later withdrawal.
CREATE SEQUENCE consent_seq;
CREATE TABLE consent (
  id          uuid        PRIMARY KEY,
  seq         bigint      NOT NULL UNIQUE,
  patient_id  uuid        NOT NULL,
  org_id      uuid        NOT NULL,
  purpose     text        NOT NULL CHECK (purpose IN (
                'self_tracking', 'share_with_care_team', 'research_deidentified',
                'org_aggregate_reporting')),
  status      text        NOT NULL CHECK (status IN ('granted', 'declined', 'revoked')),
  version     integer     NOT NULL CHECK (version >= 1),
  decided_at  timestamptz NOT NULL,
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id)
);
CREATE INDEX consent_current_idx ON consent (patient_id, purpose, seq DESC);

-- The single definition of "current consent". security_invoker keeps row-level security.
CREATE VIEW consent_current WITH (security_invoker = true) AS
  SELECT DISTINCT ON (patient_id, purpose) *
  FROM consent
  ORDER BY patient_id, purpose, seq DESC;

-- Row-level security: every table is visible only within the current organisation.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organization USING (id = endo_current_org());

ALTER TABLE clinician ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinician FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON clinician
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

ALTER TABLE patient_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_record FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON patient_record
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

ALTER TABLE enrolment_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrolment_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON enrolment_invitation
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
-- The lookup role (function owner only) may read invitations across organisations.
CREATE POLICY cross_org_lookup ON enrolment_invitation FOR SELECT TO endo_clinical_lookup
  USING (true);

ALTER TABLE consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON consent
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

-- Functions are created through format() so their search_path names this schema explicitly.
DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- Consent: serialise per patient and purpose, then assign order and time.
  EXECUTE format($f$
    CREATE FUNCTION consent_assign_order() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.patient_id::text || ':' || NEW.purpose, 0));
      NEW.seq := nextval('%I.consent_seq');
      NEW.decided_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s, s);

  EXECUTE format($f$
    CREATE FUNCTION consent_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      RAISE EXCEPTION 'consent is append-only (%% refused)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $b$
  $f$, s);

  -- Invitations move forward only: live -> claimed, or live -> revoked. Final states never change.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_invitation_transition() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF OLD.claimed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'enrolment invitation is final' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.claimed_at IS NOT NULL THEN
        IF OLD.expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION 'enrolment invitation expired' USING ERRCODE = 'check_violation';
        END IF;
        NEW.claimed_at := clock_timestamp();
      ELSIF NEW.revoked_at IS NOT NULL THEN
        NEW.revoked_at := clock_timestamp();
      ELSE
        RAISE EXCEPTION 'enrolment invitation update must claim or revoke'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);

  -- The only cross-organisation lookup. Owned by endo_clinical_lookup (below), which can read
  -- invitations everywhere but nothing else, and runs with that owner's rights.
  EXECUTE format($f$
    CREATE FUNCTION enrolment_find_live(p_token_hash char(64)) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT jsonb_build_object('invitation_id', i.id, 'org_id', i.org_id)
      FROM %I.enrolment_invitation AS i
      WHERE i.token_hash = p_token_hash
        AND i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    $b$
  $f$, s, s);

  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION enrolment_find_live(char) OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO endo_clinical_app', s);
END;
$migration$;

CREATE TRIGGER consent_order BEFORE INSERT ON consent
  FOR EACH ROW EXECUTE FUNCTION consent_assign_order();
CREATE TRIGGER consent_no_update_delete BEFORE UPDATE OR DELETE ON consent
  FOR EACH ROW EXECUTE FUNCTION consent_append_only();
CREATE TRIGGER consent_no_truncate BEFORE TRUNCATE ON consent
  FOR EACH STATEMENT EXECUTE FUNCTION consent_append_only();
CREATE TRIGGER enrolment_invitation_forward_only BEFORE UPDATE ON enrolment_invitation
  FOR EACH ROW EXECUTE FUNCTION enrolment_invitation_transition();

-- Least privilege. The API cannot set times, ordering or lifecycle fields on insert, cannot
-- delete anything, and cannot rewrite consent history.
REVOKE ALL ON organization, clinician, patient_record, enrolment_invitation, consent,
  consent_current, consent_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION enrolment_find_live(char) FROM PUBLIC;
GRANT SELECT (id, org_id, token_hash, expires_at, claimed_at, revoked_at)
  ON enrolment_invitation TO endo_clinical_lookup;

GRANT SELECT ON organization, clinician, patient_record TO endo_clinical_app;
GRANT INSERT (id, org_id, identity_ref, birth_year, preferred_language)
  ON patient_record TO endo_clinical_app;
GRANT SELECT ON enrolment_invitation TO endo_clinical_app;
GRANT INSERT (id, org_id, created_by, token_hash, expires_at)
  ON enrolment_invitation TO endo_clinical_app;
GRANT UPDATE (claimed_at, patient_id, revoked_at) ON enrolment_invitation TO endo_clinical_app;
GRANT SELECT ON consent, consent_current TO endo_clinical_app;
GRANT INSERT (id, patient_id, org_id, purpose, status, version) ON consent TO endo_clinical_app;
GRANT USAGE ON SEQUENCE consent_seq TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION enrolment_find_live(char) TO endo_clinical_app;
