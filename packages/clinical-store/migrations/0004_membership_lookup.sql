-- Cross-organisation membership lookup for clinician sign-in (ADR-0019 section 4).
--
-- At sign-in no organisation is chosen yet, so finding a clinician's organisations must cross
-- tenants. Like the invitation lookup (0001), this is a single SECURITY DEFINER function owned by
-- a no-login role that can read only the clinician columns it needs. Tenant row-level security
-- for the API role is unchanged.
--
-- Input: an exact identity reference. Output: that person's ACTIVE memberships as
-- [{ "org_id", "role" }], nothing else. An unknown reference returns an empty array.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'endo_clinical_membership_lookup') THEN
    RAISE EXCEPTION 'endo_clinical_membership_lookup missing: run packages/clinical-store/bootstrap/roles.sql first';
  END IF;
  IF pg_has_role('endo_clinical_app', 'endo_clinical_membership_lookup', 'MEMBER') THEN
    RAISE EXCEPTION 'endo_clinical_app must not be a member of endo_clinical_membership_lookup';
  END IF;
END;
$$;

CREATE POLICY membership_lookup ON clinician FOR SELECT TO endo_clinical_membership_lookup
  USING (true);
GRANT SELECT (org_id, identity_ref, role, active) ON clinician TO endo_clinical_membership_lookup;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION clinician_memberships_active(p_identity_ref uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT coalesce(
        jsonb_agg(jsonb_build_object('org_id', c.org_id, 'role', c.role) ORDER BY c.org_id),
        '[]'::jsonb)
      FROM %I.clinician AS c
      WHERE c.identity_ref = p_identity_ref AND c.active
    $b$
  $f$, s, s);

  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_membership_lookup', s);
  ALTER FUNCTION clinician_memberships_active(uuid) OWNER TO endo_clinical_membership_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_membership_lookup', s);
END;
$migration$;

REVOKE ALL ON FUNCTION clinician_memberships_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinician_memberships_active(uuid) TO endo_clinical_app;
