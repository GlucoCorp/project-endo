-- Identity vault (spec 5.2, 11.1, 11.2; REQ-009; ADR-0017). The only store with names, emails and
-- phone numbers. Only the identity service connects, as a member of endo_identity_app; the API
-- never joins across databases (spec 5.2).
--
-- Every identity field is encrypted (AES-256-GCM, kms/identity) under the person's own data key.
-- Erasing a person records a tombstone, and the database then deletes her key in the same
-- transaction (crypto-shredding). Creating and destroying a key take the same per-person lock, so
-- a key being created at that moment cannot survive. The API role cannot delete a key directly.
--
-- What this guarantees: once committed, no query can return her key and no new key can be made.
-- Copies of the wrapped key remain in dead row versions until VACUUM, and in WAL and backups until
-- they expire (REQ-009 allows normal backup expiry). A restore must replay the tombstones before
-- serving traffic (runbook, M6).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_identity_app') THEN
    RAISE EXCEPTION 'identity role missing: run packages/identity-store/bootstrap/roles.sql first';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO endo_identity_app', current_schema());
END;
$$;

CREATE TABLE person (
  id                      uuid        PRIMARY KEY,
  -- Opaque subject from the identity provider (Keycloak), used to find her at sign-in.
  idp_subject             text        UNIQUE CHECK (char_length(idp_subject) BETWEEN 1 AND 255),
  email_encrypted         text        CHECK (char_length(email_encrypted) <= 4096),
  phone_encrypted         text        CHECK (char_length(phone_encrypted) <= 4096),
  display_name_encrypted  text        CHECK (char_length(display_name_encrypted) <= 4096),
  created_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);

-- One wrapped data key per person. destroy() deletes the row (not a soft delete).
CREATE TABLE person_key (
  person_id   uuid        PRIMARY KEY REFERENCES person (id) ON DELETE CASCADE,
  wrapped     bytea       NOT NULL CHECK (octet_length(wrapped) BETWEEN 16 AND 1024),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Tombstones of shredded keys: kept so a key is never silently re-created for an erased person.
CREATE TABLE person_key_shredded (
  person_id    uuid        PRIMARY KEY,
  shredded_at  timestamptz NOT NULL DEFAULT now()
);

-- Spec 5.2 PatientLink: which pseudonymous patient records (clinical store) belong to a person.
CREATE TABLE patient_link (
  person_id          uuid        NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  patient_record_id  uuid        NOT NULL UNIQUE,
  org_id             uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, patient_record_id)
);

-- Key lifecycle, enforced in the database:
--   insert key:        lock person, refuse if a tombstone exists
--   insert tombstone:  lock person, then delete the key (as the owner, via SECURITY DEFINER)
--   delete key:        only allowed once a tombstone exists
DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION person_key_lock(p_person uuid) RETURNS void
    LANGUAGE sql SET search_path = %I, pg_temp AS $b$
      SELECT pg_advisory_xact_lock(hashtextextended('person_key:' || p_person::text, 0))
    $b$
  $f$, s);

  EXECUTE format($f$
    CREATE FUNCTION person_key_not_shredded() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      PERFORM %I.person_key_lock(NEW.person_id);
      IF EXISTS (SELECT 1 FROM %I.person_key_shredded WHERE person_id = NEW.person_id) THEN
        RAISE EXCEPTION 'person key was shredded' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s, s, s);

  EXECUTE format($f$
    CREATE FUNCTION person_key_shred_lock() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      PERFORM %I.person_key_lock(NEW.person_id);
      RETURN NEW;
    END;
    $b$
  $f$, s, s);

  -- Runs after the tombstone row exists, as the table owner, so the API role needs no DELETE.
  EXECUTE format($f$
    CREATE FUNCTION person_key_shred() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    BEGIN
      DELETE FROM %I.person_key WHERE person_id = NEW.person_id;
      RETURN NULL;
    END;
    $b$
  $f$, s, s);

  EXECUTE format($f$
    CREATE FUNCTION person_key_delete_needs_tombstone() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM %I.person_key_shredded WHERE person_id = OLD.person_id)
         AND EXISTS (SELECT 1 FROM %I.person WHERE id = OLD.person_id) THEN
        RAISE EXCEPTION 'a person key is deleted only by shredding' USING ERRCODE = 'check_violation';
      END IF;
      RETURN OLD;
    END;
    $b$
  $f$, s, s, s);
END;
$migration$;

CREATE TRIGGER person_key_not_shredded BEFORE INSERT ON person_key
  FOR EACH ROW EXECUTE FUNCTION person_key_not_shredded();
CREATE TRIGGER person_key_delete_needs_tombstone BEFORE DELETE ON person_key
  FOR EACH ROW EXECUTE FUNCTION person_key_delete_needs_tombstone();
CREATE TRIGGER person_key_shred_lock BEFORE INSERT ON person_key_shredded
  FOR EACH ROW EXECUTE FUNCTION person_key_shred_lock();
CREATE TRIGGER person_key_shred AFTER INSERT ON person_key_shredded
  FOR EACH ROW EXECUTE FUNCTION person_key_shred();
REVOKE ALL ON FUNCTION person_key_lock(uuid), person_key_shred() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_key_lock(uuid) TO endo_identity_app;

REVOKE ALL ON person, person_key, person_key_shredded, patient_link FROM PUBLIC;
GRANT SELECT ON person, person_key, person_key_shredded, patient_link TO endo_identity_app;
GRANT INSERT (id, idp_subject, email_encrypted, phone_encrypted, display_name_encrypted)
  ON person TO endo_identity_app;
GRANT UPDATE (idp_subject, email_encrypted, phone_encrypted, display_name_encrypted, deleted_at)
  ON person TO endo_identity_app;
GRANT INSERT (person_id, wrapped) ON person_key TO endo_identity_app;
GRANT INSERT (person_id) ON person_key_shredded TO endo_identity_app;
GRANT INSERT (person_id, patient_record_id, org_id) ON patient_link TO endo_identity_app;
