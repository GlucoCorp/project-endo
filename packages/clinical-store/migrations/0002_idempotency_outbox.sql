-- Idempotent replays and a same-transaction audit outbox (spec 2.6, 9.1; ADR-0017).
--
-- idempotency_record: one row per (organisation, actor, operation, Idempotency-Key). It stores a
-- hash of the request and the original response sealed with its own data key (EnvelopeSealer),
-- so a retried request after a lost response gets the same answer for 24 hours and never a second
-- side effect. The product owner chose this over a token-less replay on 2026-11-08 (Section 24
-- item 19). Expired rows are never served. The retention job (M6) clears the sealed response but
-- keeps the row as a tombstone, so an Idempotency-Key can never create twice.
--
-- audit_outbox: audit events written in the same transaction as the change they describe, then
-- relayed to the audit store by a separate relay role. The API may only add events. Delivery is
-- at least once and unordered; each event keeps its original time (created_at). An event that
-- keeps failing is set aside after 5 attempts (alerted), so it cannot block the others.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_relay') THEN
    RAISE EXCEPTION 'endo_clinical_relay missing: run packages/clinical-store/bootstrap/roles.sql first';
  END IF;
END;
$$;

CREATE TABLE idempotency_record (
  org_id                uuid        NOT NULL REFERENCES organization (id),
  actor_ref             uuid        NOT NULL,
  operation             text        NOT NULL CHECK (char_length(operation) <= 64
                          AND operation ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  idem_key              uuid        NOT NULL,
  request_hash          char(64)    NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status_code           smallint    NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  response_wrapped_key  text        CHECK (char_length(response_wrapped_key) <= 1024),
  response_envelope     text        CHECK (char_length(response_envelope) <= 16384),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (org_id, actor_ref, operation, idem_key),
  CHECK (expires_at = created_at + interval '24 hours'),
  CHECK ((response_wrapped_key IS NULL) = (response_envelope IS NULL))
);

ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON idempotency_record
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

CREATE TABLE audit_outbox (
  id            uuid        PRIMARY KEY,
  seq           bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  event         jsonb       NOT NULL CHECK (jsonb_typeof(event) = 'object'
                  AND octet_length(event::text) <= 4096),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      smallint    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text        CHECK (last_error IS NULL OR (char_length(last_error) <= 64
                  AND last_error ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'))
);
CREATE INDEX audit_outbox_pending_idx ON audit_outbox (seq) WHERE published_at IS NULL AND attempts < 5;

-- Events are immutable; publishing happens once.
DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION audit_outbox_publish_once() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF OLD.published_at IS NOT NULL OR NEW.event IS DISTINCT FROM OLD.event
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'audit_outbox rows are published once and never changed'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.published_at IS NOT NULL THEN
        NEW.published_at := clock_timestamp();
      ELSIF NEW.attempts <> OLD.attempts + 1 THEN
        RAISE EXCEPTION 'audit_outbox failures are counted one at a time'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);
END;
$migration$;

CREATE TRIGGER audit_outbox_forward_only BEFORE UPDATE ON audit_outbox
  FOR EACH ROW EXECUTE FUNCTION audit_outbox_publish_once();

REVOKE ALL ON idempotency_record, audit_outbox FROM PUBLIC;
GRANT SELECT ON idempotency_record TO endo_clinical_app;
GRANT INSERT (org_id, actor_ref, operation, idem_key, request_hash, status_code,
  response_wrapped_key, response_envelope) ON idempotency_record TO endo_clinical_app;
-- The API adds events and nothing else: it cannot read, acknowledge or hide them.
GRANT INSERT (id, event) ON audit_outbox TO endo_clinical_app;
DO $grant$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO endo_clinical_relay', current_schema());
END;
$grant$;
GRANT SELECT ON audit_outbox TO endo_clinical_relay;
GRANT UPDATE (published_at, attempts, last_error) ON audit_outbox TO endo_clinical_relay;
