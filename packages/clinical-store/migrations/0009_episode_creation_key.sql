-- Idempotent episode drafting (spec 9.1, REQ-002). The clinician's Idempotency-Key is kept with
-- the draft: a retry with the same key finds the same episode instead of creating a second one.
-- Unique per prescriber, so one clinician's keys never collide with another's. Fixed once set
-- (the API role cannot update it).

ALTER TABLE treatment_episode ADD COLUMN creation_key uuid NOT NULL;
ALTER TABLE treatment_episode ADD CONSTRAINT treatment_episode_creation_key
  UNIQUE (prescriber_id, creation_key);

GRANT INSERT (creation_key) ON treatment_episode TO endo_clinical_app;
