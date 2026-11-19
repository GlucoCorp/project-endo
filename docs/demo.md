# Demo script

How to show Project Endo end to end on a laptop, with synthetic data only (spec 0 rule 2). The browser suites drive the real patient and clinic apps through the real BFFs (the API is stood in for), so they are the dependable demo; run them headed to watch.

## Setup (once)

```sh
corepack enable && pnpm install
pnpm --filter @endo/patient-web exec playwright install --only-shell chromium
pnpm --filter @endo/clinic-web exec playwright install --only-shell chromium
```

## 1. The patient (about 5 minutes)

```sh
pnpm --filter @endo/patient-web exec vite build
pnpm --filter @endo/patient-web exec playwright test --headed --project=chromium
```

What to point out, in order:

1. **Goal and confirmation (REQ-002):** she confirms the treatment her clinician drafted and sets a goal in her own words (encrypted under her own key).
2. **Red flag (REQ-007):** answering a red-flag question shows the urgent screen first, with the local emergency number, before anything else; it works offline.
3. **Offline check-in (REQ-003):** with the network off, the week is queued encrypted on the phone and sent when she is back online, once.
4. **Quick exit (RISK-S02):** one tap clears the screen, ends the session and destroys the offline queue and its key.
5. **History and sharing (REQ-008):** her Trial Cards; a share link whose token never appears in a request URL; the receiver sees no name or clinic; stopping the link; her access log.
6. **Her data (REQ-009):** download her record (a FHIR Bundle); ask for deletion with an explicit "I understand"; keep her account during the 14 days.

## 2. The clinic (about 5 minutes)

```sh
pnpm --filter @endo/clinic-web exec vite build
pnpm --filter @endo/clinic-web exec playwright test --headed --project=chromium
```

1. **Enrolment in the clinic (REQ-001, ADR-0021):** the clinician types the code shown on her phone and attests they identified her.
2. **The desk (REQ-005):** the review queue with red flags first; the review with the Trial Strip; a decision (continue keeps the treatment; switch changes it).
3. **Pre-surgery check (REQ-006):** facts from her record, "properly tried" left for the clinical lead to define; saved only for the preview acknowledged.

Organisation settings, team, staff invitations (REQ-010) and the dashboard (REQ-011) are covered by unit tests (`apps/clinic-web/src/admin/admin.test.ts`); open `/admin` and `/dashboard` from the desk as an org admin in a full stack.

## 3. Operations (about 3 minutes)

Restore drill on the local test server (synthetic data):

```sh
node tools/backup.mjs --db endo_drill_src --out ./drill --key ./drill/backup.key \
  --exec "docker exec -i endo-test-db"
node tools/restore-drill.mjs --manifest ./drill/<name>.manifest.json --key ./drill/backup.key \
  --scratch endo_drill_demo --report ./drill/report.md --exec "docker exec -i endo-test-db"
```

Show the report: hash and auth tag verified before restoring, row counts, and that no shredded key or erased patient came back. Run it again with a wrong key: it fails at the auth tag, before anything is restored.

## 4. Record systems (about 3 minutes)

```sh
pnpm --filter @endo/integration test
```

Walk through `services/integration/src/app.test.ts`: discovery, a signed client assertion exchanged for a 5-minute token, replays and foreign keys refused, reads by patient only, OperationOutcome errors, and the kill switch taking effect on the next request. SMART App Launch (record system opens the desk on the right patient, linked once by hash): `services/bff-clinic/src/enrolments.test.ts`, "M7 SMART App Launch".

## What not to claim

- Verdicts run in shadow mode: no verdict is shown to anyone (ADR-0028).
- All clinical content is placeholder (`TODO_CLINICAL`) until the clinical lead signs it off.
- Not yet done by humans: the external penetration test, the DPIA and clinical safety sign-offs, a staging restore drill, Inferno against staging (ADR-0031, proposed), and a pilot site's record-system sandbox.
