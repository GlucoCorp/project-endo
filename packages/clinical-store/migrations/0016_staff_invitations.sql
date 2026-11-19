-- Staff invitations (REQ-010 "invite clinicians"; spec 3.2, 10.2).
--
-- An org_admin invites a colleague with a role. Only the SHA-256 of the link token is stored; the
-- token exists only in the link. Valid at most 7 days, single use, revocable. The invited person
-- signs in with their own staff account (passkey), and the clinic BFF claims the invitation for
-- the person that sign-in resolved to: staff_invitation_claim() creates the membership.
--
-- The claim crosses organisations by design (the token names the organisation), so it runs in two
-- steps: staff_invitation_find() (owned by endo_clinical_lookup, ids only) finds the live
-- invitation's organisation; staff_invitation_claim() (SECURITY DEFINER, schema owner) then works
-- inside that organisation's row-level security scope.

CREATE TABLE staff_invitation (
  id                   uuid        PRIMARY KEY,
  org_id               uuid        NOT NULL REFERENCES organization (id),
  role                 text        NOT NULL CHECK (role IN ('clinician', 'org_admin')),
  token_hash           char(64)    NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by           uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  claimed_at           timestamptz,
  claimed_clinician_id uuid,
  revoked_at           timestamptz,
  FOREIGN KEY (created_by, org_id) REFERENCES clinician (id, org_id),
  FOREIGN KEY (claimed_clinician_id, org_id) REFERENCES clinician (id, org_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((claimed_at IS NULL) = (claimed_clinician_id IS NULL)),
  CHECK (claimed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX staff_invitation_org_idx ON staff_invitation (org_id, created_at DESC);

ALTER TABLE staff_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON staff_invitation
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
CREATE POLICY cross_org_lookup ON staff_invitation FOR SELECT TO endo_clinical_lookup USING (true);
GRANT SELECT (id, org_id, token_hash, expires_at, claimed_at, revoked_at)
  ON staff_invitation TO endo_clinical_lookup;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  -- created_at is the database clock, never the caller's; expiry at most 7 days from it.
  EXECUTE format($f$
    CREATE FUNCTION staff_invitation_stamp() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.created_at := now();
        NEW.expires_at := least(NEW.expires_at, now() + interval '7 days');
        NEW.claimed_at := NULL;
        NEW.claimed_clinician_id := NULL;
        NEW.revoked_at := NULL;
        RETURN NEW;
      END IF;
      -- Forward only: revoke an open invitation; claims happen in staff_invitation_claim().
      IF OLD.claimed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'staff invitation is final' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $b$
  $f$, s);

  EXECUTE format($f$
    CREATE FUNCTION staff_invitation_find(p_token_hash char(64)) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT org_id FROM %I.staff_invitation
      WHERE token_hash = p_token_hash AND claimed_at IS NULL AND revoked_at IS NULL
        AND expires_at > now()
    $b$
  $f$, s, s);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION staff_invitation_find(char) OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);

  -- Returns the organisation and role on success; 'unavailable' for a wrong, used, revoked or
  -- expired link; 'already_member' if the person is already in the organisation.
  EXECUTE format($f$
    CREATE FUNCTION staff_invitation_claim(p_token_hash char(64), p_identity_ref uuid,
                                           p_clinician_id uuid, p_audit jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
    DECLARE
      v_org uuid;
      v_inv %I.staff_invitation%%ROWTYPE;
    BEGIN
      v_org := %I.staff_invitation_find(p_token_hash);
      IF v_org IS NULL THEN
        RETURN jsonb_build_object('outcome', 'unavailable');
      END IF;
      PERFORM set_config('app.org_id', v_org::text, true);
      SELECT * INTO v_inv FROM %I.staff_invitation
        WHERE token_hash = p_token_hash AND claimed_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
        FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome', 'unavailable');
      END IF;
      IF EXISTS (SELECT 1 FROM %I.clinician WHERE org_id = v_org AND identity_ref = p_identity_ref)
      THEN
        RETURN jsonb_build_object('outcome', 'already_member');
      END IF;
      INSERT INTO %I.clinician (id, org_id, identity_ref, role)
        VALUES (p_clinician_id, v_org, p_identity_ref, v_inv.role);
      UPDATE %I.staff_invitation SET claimed_at = now(), claimed_clinician_id = p_clinician_id
        WHERE id = v_inv.id;
      INSERT INTO %I.audit_outbox (id, event)
        VALUES ((p_audit ->> 'id')::uuid,
                jsonb_set(jsonb_set(p_audit, '{org_id}', to_jsonb(v_org::text)),
                          '{resource}', jsonb_build_object('type', 'staff_invitation',
                                                           'id', v_inv.id::text)));
      RETURN jsonb_build_object('outcome', 'claimed', 'org_id', v_org, 'role', v_inv.role);
    END;
    $b$
  $f$, s, s, s, s, s, s, s, s);
END
$migration$;

CREATE TRIGGER staff_invitation_stamp BEFORE INSERT OR UPDATE ON staff_invitation
  FOR EACH ROW EXECUTE FUNCTION staff_invitation_stamp();

REVOKE ALL ON staff_invitation FROM PUBLIC;
REVOKE ALL ON FUNCTION staff_invitation_find(char), staff_invitation_claim(char, uuid, uuid, jsonb)
  FROM PUBLIC;
GRANT SELECT (id, org_id, role, created_by, created_at, expires_at, claimed_at,
              claimed_clinician_id, revoked_at),
  INSERT (id, org_id, role, token_hash, created_by, expires_at)
  ON staff_invitation TO endo_clinical_app;
GRANT UPDATE (revoked_at) ON staff_invitation TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION staff_invitation_find(char), staff_invitation_claim(char, uuid, uuid, jsonb)
  TO endo_clinical_app;
