-- Email one-time codes (spec 10.1; ADR-0026; REQ-001, RISK-S04).
--
-- Her email address is encrypted under her own key (person.email_encrypted), so it cannot be
-- looked up. `email_index` is a blind index: HMAC-SHA-256 of the normalised address under one
-- `kms/identity` data key, wrapped and stored once in `identity_index_key`. Only a confirmed
-- address is indexed, and erasure clears it.
--
-- Every code request is a row, also for an address that is no patient's (no person, no code), so
-- the limits count everything and an answer never tells whether an address is known. The
-- database holds the rules, whatever the caller:
-- - a code lives 10 minutes from creation (set by the database clock), is used at most once, and
--   locks after 5 wrong entries; nothing about a request changes except those counters;
-- - only the code's MAC and wrapped key are kept, never the code;
-- - every write has its audit event in the identity outbox, in the same database transaction.

CREATE TABLE identity_index_key (
  purpose      text        PRIMARY KEY CHECK (purpose IN ('email')),
  wrapped_key  text        NOT NULL CHECK (char_length(wrapped_key) BETWEEN 16 AND 1024),
  created_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON identity_index_key FROM PUBLIC;

ALTER TABLE person
  ADD COLUMN email_index        char(64) UNIQUE CHECK (email_index ~ '^[0-9a-f]{64}$'),
  ADD COLUMN email_confirmed_at timestamptz,
  ADD CONSTRAINT person_email_index_confirmed CHECK ((email_index IS NULL) = (email_confirmed_at IS NULL));

CREATE TABLE email_code (
  id                uuid        PRIMARY KEY,
  purpose           text        NOT NULL CHECK (purpose IN ('sign-in', 'confirm')),
  -- Null when the address belongs to no patient: the request is counted, nothing is sent.
  person_id         uuid        REFERENCES person (id) ON DELETE CASCADE,
  address_index     char(64)    NOT NULL CHECK (address_index ~ '^[0-9a-f]{64}$'),
  -- HMAC of the client IP under the same key, for the per-IP limit; never the IP itself.
  source_index      char(64)    NOT NULL CHECK (source_index ~ '^[0-9a-f]{64}$'),
  code_wrapped_key  text        CHECK (char_length(code_wrapped_key) <= 1024),
  code_mac          text        CHECK (char_length(code_mac) <= 128),
  -- Confirming a new address: that address, encrypted under her key, until it is confirmed.
  pending_email     text        CHECK (char_length(pending_email) <= 4096),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT now(),
  attempts          smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  used_at           timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((person_id IS NULL) = (code_mac IS NULL) AND (code_mac IS NULL) = (code_wrapped_key IS NULL)),
  CHECK (purpose = 'confirm' OR pending_email IS NULL),
  CHECK (purpose = 'sign-in' OR person_id IS NOT NULL)
);
REVOKE ALL ON email_code FROM PUBLIC;
CREATE INDEX email_code_address_idx ON email_code (address_index, created_at);
CREATE INDEX email_code_source_idx ON email_code (source_index, created_at);

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION email_code_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'DELETE' THEN
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
    CREATE FUNCTION email_code_audited() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM audit_outbox AS o
        WHERE o.event->'resource'->>'id' = NEW.id::text
          AND o.xmin = pg_current_xact_id()::xid
      ) THEN
        RAISE EXCEPTION 'email code change without its audit event'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $b$
  $f$, s);

  EXECUTE format($f$
    CREATE FUNCTION identity_index_key_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      RAISE EXCEPTION 'an index key never changes' USING ERRCODE = 'check_violation';
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER email_code_guard BEFORE INSERT OR UPDATE OR DELETE ON email_code
  FOR EACH ROW EXECUTE FUNCTION email_code_guard();
CREATE CONSTRAINT TRIGGER email_code_audited AFTER INSERT OR UPDATE ON email_code
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION email_code_audited();
CREATE TRIGGER identity_index_key_guard BEFORE UPDATE OR DELETE ON identity_index_key
  FOR EACH ROW EXECUTE FUNCTION identity_index_key_guard();

REVOKE ALL ON FUNCTION email_code_guard(), email_code_audited(), identity_index_key_guard()
  FROM PUBLIC;
GRANT SELECT ON identity_index_key, email_code TO endo_identity_app;
GRANT INSERT (purpose, wrapped_key) ON identity_index_key TO endo_identity_app;
GRANT INSERT (id, purpose, person_id, address_index, source_index, code_wrapped_key, code_mac,
  pending_email) ON email_code TO endo_identity_app;
GRANT UPDATE (attempts, used_at) ON email_code TO endo_identity_app;
GRANT UPDATE (email_index, email_confirmed_at) ON person TO endo_identity_app;
