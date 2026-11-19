-- Verdicts in shadow mode (M3: REQ-004; spec 7, 18.5). One row per generation attempt: either a
-- verdict with its rule set version and digest, instrument version, input snapshot hash and
-- explanation trace, or the reason none was generated (for example an incomplete rule set).
-- Append-only. `shadow` stays true until verdicts are cleared for use in care (spec 7.4, 22 M3):
-- shadow verdicts are stored for comparison with clinicians' own judgement and shown to no one in
-- the care path.

CREATE TABLE verdict (
  id                  uuid        PRIMARY KEY,
  org_id              uuid        NOT NULL,
  patient_id          uuid        NOT NULL,
  episode_id          uuid        NOT NULL,
  outcome             text        NOT NULL CHECK (outcome IN ('generated', 'not_generated')),
  reason              text        CHECK (reason ~ '^[a-z][a-z_.]{0,63}$'),
  verdict_code        text        CHECK (verdict_code IN ('RED_FLAG', 'INSUFFICIENT_DATA',
                        'NOT_TAKEN_ENOUGH', 'NOT_TOLERATED', 'NOT_WORKING', 'PARTLY_WORKING',
                        'WORKING')),
  secondary_code      text        CHECK (secondary_code IN ('INSUFFICIENT_DATA',
                        'NOT_TAKEN_ENOUGH', 'NOT_TOLERATED', 'NOT_WORKING', 'PARTLY_WORKING',
                        'WORKING')),
  modifiers           text[]      NOT NULL DEFAULT '{}' CHECK (modifiers <@ ARRAY['SIDE_EFFECTS_LIMITING',
                        'BARRIER_COST', 'BARRIER_STOCKOUT', 'DATA_GAPS']::text[]),
  ruleset_version     text        NOT NULL CHECK (ruleset_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  ruleset_digest      char(64)    NOT NULL CHECK (ruleset_digest ~ '^[0-9a-f]{64}$'),
  instrument_version  text        NOT NULL CHECK (instrument_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  input_hash          char(64)    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  explanation         jsonb       CHECK (explanation IS NULL OR (jsonb_typeof(explanation) = 'object'
                                         AND octet_length(explanation::text) <= 16384)),
  generated_by        text        NOT NULL CHECK (generated_by IN ('system', 'on_demand')),
  requested_by        uuid,
  shadow              boolean     NOT NULL DEFAULT true,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id),
  FOREIGN KEY (requested_by, org_id) REFERENCES clinician (id, org_id),
  CHECK ((outcome = 'generated') = (verdict_code IS NOT NULL)),
  CHECK (outcome = 'not_generated' OR (input_hash IS NOT NULL AND explanation IS NOT NULL
                                       AND reason IS NULL)),
  CHECK (outcome = 'generated' OR (reason IS NOT NULL AND input_hash IS NULL
                                   AND secondary_code IS NULL)),
  CHECK (secondary_code IS NULL OR verdict_code = 'RED_FLAG'),
  CHECK ((generated_by = 'on_demand') = (requested_by IS NOT NULL))
);
-- The schedule tries once per episode and rule set version (a new rule set version tries again).
CREATE UNIQUE INDEX verdict_scheduled_once ON verdict (episode_id, ruleset_version)
  WHERE generated_by = 'system';
CREATE INDEX verdict_episode_idx ON verdict (episode_id, generated_at DESC);

ALTER TABLE verdict ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdict FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON verdict
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

-- The schedule's cross-organisation lookup (spec REQ-004: 3 days before the review date). Owned
-- by endo_clinical_lookup, which may read just these columns everywhere; it returns ids only.
CREATE POLICY cross_org_lookup ON treatment_episode FOR SELECT TO endo_clinical_lookup USING (true);
CREATE POLICY cross_org_lookup ON verdict FOR SELECT TO endo_clinical_lookup USING (true);
GRANT SELECT (id, org_id, status, review_date) ON treatment_episode TO endo_clinical_lookup;
GRANT SELECT (episode_id, ruleset_version, generated_by) ON verdict TO endo_clinical_lookup;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION verdict_due_episodes(p_today date, p_ruleset_version text)
    RETURNS TABLE (episode_id uuid, org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT e.id, e.org_id
      FROM %I.treatment_episode AS e
      WHERE e.status IN ('active', 'in_review')
        AND e.review_date - 3 <= p_today
        AND NOT EXISTS (SELECT 1 FROM %I.verdict AS v
                        WHERE v.episode_id = e.id AND v.generated_by = 'system'
                          AND v.ruleset_version = p_ruleset_version)
      ORDER BY e.review_date
      LIMIT 500
    $b$
  $f$, s, s, s);

  EXECUTE format($f$
    CREATE FUNCTION verdict_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %I, pg_temp AS $b$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.generated_at := clock_timestamp();
        NEW.shadow := true;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'verdicts are append-only (%% refused)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $b$
  $f$, s);

  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION verdict_due_episodes(date, text) OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);
END;
$migration$;

CREATE TRIGGER verdict_append_only BEFORE INSERT OR UPDATE OR DELETE ON verdict
  FOR EACH ROW EXECUTE FUNCTION verdict_append_only();

REVOKE ALL ON verdict FROM PUBLIC;
REVOKE ALL ON FUNCTION verdict_due_episodes(date, text) FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, patient_id, episode_id, outcome, reason, verdict_code,
  secondary_code, modifiers, ruleset_version, ruleset_digest, instrument_version, input_hash,
  explanation, generated_by, requested_by) ON verdict TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION verdict_due_episodes(date, text) TO endo_clinical_app;
