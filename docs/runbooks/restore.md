# Restore and restore drills

Spec 12.8 (RTO 4 hours, RPO 15 minutes; a drill every quarter with a written report), RISK-D02, REQ-009. Owner: platform on-call, with the security lead for production restores.

## Drill (quarterly, and before the pilot)

1. Pick the latest daily backup of each database (clinical, identity, audit).
2. Run, against a scratch server with the same roles bootstrapped (`packages/*/bootstrap/roles.sql`):

   ```sh
   node tools/restore-drill.mjs --manifest <backup>.manifest.json --key /run/secrets/backup.key \
     --scratch endo_drill_<yyyymmdd> --report docs/runbooks/drills/<yyyy-mm-dd>-<env>-<db>.md
   ```

3. The drill verifies the ciphertext hash and the GCM auth tag, restores into a new scratch database (it refuses an existing one and any name without `drill`), and checks:
   - row counts per table equal the manifest;
   - no shredded patient key came back (`patient_key` vs `patient_key_shredded`);
   - no erased patient record came back (`patient_record` vs erased `deletion_request`);
   - no shredded identity key came back (`person_key` vs `person_key_shredded`).
4. Time the run; it must fit inside the RTO with the restore of all three databases.
5. Commit the report (counts only) and record any failure as an incident (`incident-response.md`).

Last drill: [2026-11-16, local, synthetic data](drills/2026-11-16-local-synthetic.md): passed.

## Production restore

Only with the security lead's approval, through just-in-time access (`access-requests.md`).

1. Declare an incident (SEV-1 if service is down or data integrity is in doubt).
2. Stop writers: scale the API, identity service and jobs process to zero; the BFFs show the maintenance page.
3. Decrypt the chosen backup to a temporary encrypted volume first, and only then restore: a GCM tag mismatch must stop the restore before any row is written.
4. Restore each database (point-in-time recovery for the last 15 minutes where available).
5. **Replay erasures before serving traffic (REQ-009):**
   - In the clinical database, for every `deletion_request` with `erased_at` set in the newest available copy (the audit store and the live backup account hold them), run `patient_erase` again; it is idempotent and destroys keys first.
   - In the identity database, run `person_purge` for every person whose erasure is recorded in the audit store (`identity.person.erased` / `identity.person.purged` events).
   - Re-run `tools/restore-drill.mjs` invariants against the restored databases (use `--keep` and a scratch copy, or the SQL in the script).
6. Verify the audit hash chain (`@endo/audit` `verifyChain`) and that the outbox relays drain.
7. Start the services; watch authentication failures, denied-authorisation spikes and job backlogs (spec 15).
8. Write the incident report, including the data loss window.
