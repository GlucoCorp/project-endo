-- Handoffs into Keycloak (ADR-0021 sections 5 and 6; REQ-001, RISK-S04, RISK-S05).
--
-- After the clinic confirms, her browser chooses "Continue". The patient BFF starts its own OIDC
-- request and asks the coordinator for a handoff: a one-time, five-minute grant bound to the
-- transaction, the issuer, the client, its exact redirect URI, the PKCE S256 challenge, `state`
-- and `nonce`. Only an opaque reference travels in the authorisation URL; its SHA-256 is stored.
-- The Keycloak extension redeems it, and the coordinator compares every bound value with the
-- real request. The database holds the rules, whatever the caller:
-- - a handoff is written once, for an open transaction, expiring at most five minutes later;
-- - it is redeemed at most once, before it expires, recording Keycloak's authentication-session
--   identity (root session id, client id, tab id); after that it never changes (an identical
--   retry from the same Keycloak session is answered by the service from the stored row);
-- - its bound values never change;
-- - every change has its audit event in the identity outbox, in the same database transaction.

CREATE TABLE enrolment_handoff (
  ref_hash          char(64)    PRIMARY KEY CHECK (ref_hash ~ '^[0-9a-f]{64}$'),
  transaction_id    uuid        NOT NULL REFERENCES enrolment_transaction (id),
  kind              text        NOT NULL CHECK (kind IN ('enrol', 'resume')),
  issuer            text        NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 255),
  client_id         text        NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
  redirect_uri      text        NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  code_challenge    text        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state             text        NOT NULL CHECK (char_length(state) BETWEEN 16 AND 255),
  nonce             text        NOT NULL CHECK (char_length(nonce) BETWEEN 16 AND 255),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Set by the database: five minutes after creation (the guard trigger).
  expires_at        timestamptz NOT NULL DEFAULT now(),
  redeemed_at       timestamptz,
  -- Keycloak's authentication session that redeemed it (section 6): an identical retry from the
  -- same session gets the same answer; any other session is refused.
  kc_root_session   text        CHECK (char_length(kc_root_session) BETWEEN 1 AND 255),
  kc_client_uuid    text        CHECK (char_length(kc_client_uuid) BETWEEN 1 AND 255),
  kc_tab_id         text        CHECK (char_length(kc_tab_id) BETWEEN 1 AND 255),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK ((redeemed_at IS NULL) = (kc_root_session IS NULL)
     AND (redeemed_at IS NULL) = (kc_client_uuid IS NULL)
     AND (redeemed_at IS NULL) = (kc_tab_id IS NULL))
);
CREATE INDEX enrolment_handoff_transaction_idx ON enrolment_handoff (transaction_id);
REVOKE ALL ON enrolment_handoff FROM PUBLIC;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION enrolment_handoff_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.redeemed_at IS NOT NULL THEN
          RAISE EXCEPTION 'a handoff starts unredeemed' USING ERRCODE = 'check_violation';
        END IF;
        -- The database clock sets both times: a handoff lasts exactly five minutes.
        NEW.created_at := clock_timestamp();
        NEW.expires_at := NEW.created_at + interval '5 minutes';
        RETURN NEW;
      END IF;
      IF ROW(NEW.ref_hash, NEW.transaction_id, NEW.kind, NEW.issuer, NEW.client_id,
             NEW.redirect_uri, NEW.code_challenge, NEW.state, NEW.nonce, NEW.created_at,
             NEW.expires_at)
         IS DISTINCT FROM
         ROW(OLD.ref_hash, OLD.transaction_id, OLD.kind, OLD.issuer, OLD.client_id,
             OLD.redirect_uri, OLD.code_challenge, OLD.state, OLD.nonce, OLD.created_at,
             OLD.expires_at) THEN
        RAISE EXCEPTION 'a handoff binding is fixed' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.redeemed_at IS NOT NULL THEN
        RAISE EXCEPTION 'a handoff is redeemed once' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.redeemed_at IS NULL OR clock_timestamp() > OLD.expires_at THEN
        RAISE EXCEPTION 'a handoff is redeemed once, before it expires'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.redeemed_at := clock_timestamp();
      RETURN NEW;
    END;
    $b$
  $f$, s);

  EXECUTE format($f$
    CREATE FUNCTION enrolment_handoff_audited() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM audit_outbox AS o
        WHERE o.event->'resource'->>'id' = NEW.transaction_id::text
          AND o.xmin = pg_current_xact_id()::xid
      ) THEN
        RAISE EXCEPTION 'handoff change without its audit event' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER enrolment_handoff_guard BEFORE INSERT OR UPDATE ON enrolment_handoff
  FOR EACH ROW EXECUTE FUNCTION enrolment_handoff_guard();
CREATE CONSTRAINT TRIGGER enrolment_handoff_audited AFTER INSERT OR UPDATE ON enrolment_handoff
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enrolment_handoff_audited();

REVOKE ALL ON FUNCTION enrolment_handoff_audited() FROM PUBLIC;
GRANT SELECT ON enrolment_handoff TO endo_identity_app;
GRANT INSERT (ref_hash, transaction_id, kind, issuer, client_id, redirect_uri, code_challenge,
  state, nonce) ON enrolment_handoff TO endo_identity_app;
GRANT UPDATE (redeemed_at, kc_root_session, kc_client_uuid, kc_tab_id)
  ON enrolment_handoff TO endo_identity_app;
