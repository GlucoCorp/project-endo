-- Weekly check-in reminders by Web Push (spec 15, REQ-003; Section 24 item 28).
--
-- push_subscription: her browser's push endpoint, encrypted under her own data key (it identifies
-- her device, so crypto-shredding removes it with everything else). Her chosen hour and her time
-- zone decide when; quiet hours are enforced by the sender. One row per device; she can remove it.
-- reminder_sent: one reminder per episode week, so a week is never reminded twice.

CREATE TABLE push_subscription (
  id                  uuid        PRIMARY KEY,
  org_id              uuid        NOT NULL,
  patient_id          uuid        NOT NULL,
  endpoint_encrypted  text        NOT NULL CHECK (char_length(endpoint_encrypted) BETWEEN 10 AND 4096),
  -- SHA-256 of the endpoint, to find the same device again without decrypting.
  endpoint_hash       char(64)    NOT NULL CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  remind_hour         smallint    NOT NULL DEFAULT 18 CHECK (remind_hour BETWEEN 8 AND 20),
  time_zone           text        NOT NULL CHECK (time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$'
                                                  OR time_zone = 'UTC'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, endpoint_hash),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id)
);

CREATE TABLE reminder_sent (
  episode_id  uuid        NOT NULL,
  week_index  smallint    NOT NULL CHECK (week_index BETWEEN 1 AND 26),
  org_id      uuid        NOT NULL,
  patient_id  uuid        NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (episode_id, week_index),
  FOREIGN KEY (episode_id, patient_id) REFERENCES treatment_episode (id, patient_id),
  FOREIGN KEY (patient_id, org_id) REFERENCES patient_record (id, org_id)
);

ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON push_subscription
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());
ALTER TABLE reminder_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_sent FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON reminder_sent
  USING (org_id = endo_current_org()) WITH CHECK (org_id = endo_current_org());

-- The sender's cross-organisation lookup: which organisations have subscriptions (ids only).
CREATE POLICY cross_org_lookup ON push_subscription FOR SELECT TO endo_clinical_lookup USING (true);
GRANT SELECT (org_id) ON push_subscription TO endo_clinical_lookup;

DO $migration$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE FUNCTION reminder_orgs() RETURNS TABLE (org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $b$
      SELECT DISTINCT p.org_id FROM %I.push_subscription AS p
    $b$
  $f$, s, s);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO endo_clinical_lookup', s);
  ALTER FUNCTION reminder_orgs() OWNER TO endo_clinical_lookup;
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM endo_clinical_lookup', s);
END;
$migration$;

REVOKE ALL ON push_subscription, reminder_sent FROM PUBLIC;
REVOKE ALL ON FUNCTION reminder_orgs() FROM PUBLIC;
GRANT SELECT, INSERT (id, org_id, patient_id, endpoint_encrypted, endpoint_hash, remind_hour,
  time_zone), DELETE ON push_subscription TO endo_clinical_app;
GRANT UPDATE (remind_hour, time_zone) ON push_subscription TO endo_clinical_app;
GRANT SELECT, INSERT (episode_id, week_index, org_id, patient_id) ON reminder_sent
  TO endo_clinical_app;
GRANT EXECUTE ON FUNCTION reminder_orgs() TO endo_clinical_app;
