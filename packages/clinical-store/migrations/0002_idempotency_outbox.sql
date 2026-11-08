-- Idempotent replays and a same-transaction audit outbox (spec 2.6, 9.1; ADR-0017).
--
-- idempotency_record: one row per (organisation, actor, operation, Idempotency-Key). It stores a
-- hash of the request and the original response sealed with its own data key (EnvelopeSealer),
-- so a retried request after a lost response gets the same answer for 24 hours and never a second
-- side effect. The product owner chose this over a token-less replay on 2026-11-08 (Section 24
-- item 19). Expired rows are never served and are purged by a retention job (M6).
--
-- audit_outbox: audit events written in the same transaction as the change they describe, then
-- relayed to the audit store. Opaque ids and codes only (validated before insert), so it has no
-- row-level security: the relay must read across organisations.

CREATE TABLE idempotency_record (
  org_id                uuid        NOT NULL REFERENCES organization (id),
  actor_ref             uuid        NOT NULL,
  operation             text        NOT NULL CHECK (char_length(operation) <= 64
                          AND operation ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  idem_key              uuid        NOT NULL,
  request_hash          char(64)    NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status_code           smallint    NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  response_wrapped_key  text        NOT NULL CHECK (char_length(response_wrapped_key) <= 1024),
  response_envelope     text        NOT NULL CHECK (char_length(response_envelope) <= 16384),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (org_id, actor_ref, operation, idem_key),
  CHECK (expires_at = created_at + interval '24 hours')
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
  published_at  timestamptz
);
CREATE INDEX audit_outbox_pending_idx ON audit_outbox (seq) WHERE published_at IS NULL;

-- Events are immutable; publishing happens once.
DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION audit_outbox_publish_once() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF OLD.published_at IS NOT NULL OR NEW.published_at IS NULL
         OR NEW.event IS DISTINCT FROM OLD.event THEN
        RAISE EXCEPTION 'audit_outbox rows are published once and never changed'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.published_at := clock_timestamp();
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
GRANT SELECT, INSERT (id, event) ON audit_outbox TO endo_clinical_app;
GRANT UPDATE (published_at) ON audit_outbox TO endo_clinical_app;
