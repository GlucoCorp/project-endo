-- Append-only, hash-chained audit log (spec 2.6, 12.9; ADR-0008; RISK-R01, RISK-I02).
-- Defence in depth: the application validates events with Zod, and the database enforces the same
-- shape, refuses updates/deletes/truncates, and checks every insert links to the previous hash.

CREATE TABLE audit_event (
  sequence        bigint      PRIMARY KEY CHECK (sequence >= 1),
  id              uuid        NOT NULL UNIQUE,
  occurred_at     timestamptz NOT NULL,
  prev_hash       char(64)    NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash            char(64)    NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  actor_id        uuid,
  actor_role      text        NOT NULL CHECK (actor_role IN (
                    'patient', 'clinician', 'org_admin', 'glucorp_support',
                    'glucorp_platform_admin', 'anonymous', 'system')),
  action          text        NOT NULL CHECK (char_length(action) <= 64
                    AND action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  resource_type   text        NOT NULL CHECK (char_length(resource_type) <= 64
                    AND resource_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  resource_id     uuid,
  org_id          uuid,
  purpose_of_use  text        NOT NULL CHECK (purpose_of_use IN (
                    'treatment', 'patient_request', 'operations', 'support', 'system_check')),
  outcome         text        NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  reason          text        CHECK (reason IS NULL OR (char_length(reason) <= 64
                    AND reason ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$')),
  request_id      uuid        NOT NULL
);

CREATE INDEX audit_event_actor_idx ON audit_event (actor_id, occurred_at);
CREATE INDEX audit_event_resource_idx ON audit_event (resource_type, resource_id, occurred_at);

-- Chain linkage: the first event links to the genesis hash, every later one to its predecessor.
-- Concurrent writers that pick the same sequence collide on the primary key and retry.
CREATE FUNCTION audit_event_check_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected char(64);
BEGIN
  IF NEW.sequence = 1 THEN
    expected := repeat('0', 64);
  ELSE
    SELECT hash INTO expected FROM audit_event WHERE sequence = NEW.sequence - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'audit_event: sequence % has no predecessor', NEW.sequence
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.prev_hash <> expected THEN
    RAISE EXCEPTION 'audit_event: prev_hash does not match predecessor at sequence %', NEW.sequence
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_link
  BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_check_link();

-- Append-only: no UPDATE, DELETE or TRUNCATE, whoever asks. Retention (7 years) is handled by
-- partition detachment under a separate, audited break-glass procedure (runbook, M6).
CREATE FUNCTION audit_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

-- Least privilege: the application role may only read and append. Login roles for services are
-- created by infrastructure and granted membership in endo_audit_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_audit_app') THEN
    CREATE ROLE endo_audit_app NOLOGIN;
  END IF;
END;
$$;

-- The role also needs USAGE on whichever schema this migration runs in, or it cannot see the table.
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO endo_audit_app', current_schema());
END;
$$;

REVOKE ALL ON audit_event FROM PUBLIC;
GRANT SELECT, INSERT ON audit_event TO endo_audit_app;
