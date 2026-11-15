# Project Endo: Engineering Build Specification

Version 1.0 · Owner: GluCorp Health · Status: design complete, nothing built yet

This document is the single source of truth for building Project Endo. It is written for the engineer building it (Claude Code, working with the GluCorp team) and for anyone reviewing that work. Read Section 0 before writing any code.

---

## Table of contents

0. Read me first: how to work on this codebase
1. The product on one page
2. Non-negotiables
3. Users, roles and permissions
4. Core flows and acceptance criteria
5. Domain model and FHIR mapping
6. The check-in instrument
7. The verdict engine
8. Architecture and technology choices
9. API design
10. Identity, authentication and authorisation
11. Data storage and encryption
12. Security engineering
13. Privacy features
14. The web app (PWA) specifics
15. Reminder service
16. Integration service (FHIR, SMART on FHIR)
17. Infrastructure
18. Software development lifecycle, CI/CD and traceability
19. Testing strategy
20. Observability
21. Design system and UI
22. Build order: epics and milestones
23. Repository conventions
24. Open questions that need a human

---

## 0. Read me first: how to work on this codebase

### Your role

You are the senior engineer responsible for building Project Endo to production quality. "Production quality" here means medical-grade software handling reproductive health data: secure by default, tested, traceable and boring in the best sense. Speed never beats safety.

### Operating rules

1. **Security and privacy come first.** If a shortcut weakens any control in Section 12, do not take it. Stop and ask.
2. **Never use real patient data** anywhere outside production. Use the synthetic data generator (Section 19.6).
3. **Never add a dependency without an ADR** (architecture decision record) in `docs/adr/`, stating why it is needed, alternatives considered, maintainer health, licence, and supply-chain risk. Prefer the standard library and existing dependencies.
4. **Never weaken, skip or delete a test or a CI check** to make a build pass. Fix the cause.
5. **Never write clinical logic from your own judgement.** Verdict rules, thresholds, question wording and red-flag criteria come only from `clinical/` files signed off by the clinical lead. Values marked `TODO_CLINICAL` must stay obviously unfinished and must block release.
6. **Every change traces to a requirement.** Reference requirement IDs (`REQ-…`) and risk IDs (`RISK-…`) in commit messages and tests (Section 18.4).
7. **Flag security-relevant changes for human review** by adding the `security-review` label and a short threat note in the PR description: what could go wrong, and what prevents it.
8. **Small, reviewable pull requests.** One concern per PR. A PR that touches auth, crypto, consent, audit or the verdict engine must be under 400 changed lines unless agreed beforehand.
9. **Write it down.** Update docs, ADRs and the threat model in the same PR as the code.
10. **When the spec is ambiguous, ask.** Do not invent product behaviour. Add the question to Section 24 and continue with something else.

### Definition of done (every PR)

- [ ] Requirement and risk IDs referenced.
- [ ] Unit and integration tests added; coverage of changed lines at least 90% for `packages/verdict`, `packages/authz`, `services/api/src/consent`, 80% elsewhere.
- [ ] All CI checks pass (Section 18.2), including security scans.
- [ ] No new dependency without an ADR.
- [ ] No PHI (personal health information) in logs, errors, analytics, URLs or test fixtures.
- [ ] Accessibility checks pass for UI changes (axe, keyboard walkthrough).
- [ ] Docs, OpenAPI spec and threat model updated if behaviour changed.

---

## 1. The product on one page

**Problem.** Treatment for endometriosis, adenomyosis and fibroids is trial and error, and nobody measures the trials. A woman starts a treatment; months later she tells her clinician from memory whether it helped. Clinicians cannot tell whether a treatment failed, was not tolerated, or was not taken (because of cost, stock-outs or forgetting). Women end up on ineffective treatments for years or lose their womb to surgery that careful treatment might have avoided.

**Product.** Project Endo turns every treatment into a measured trial:

1. At the prescribing visit, the clinician starts a **treatment episode**: treatment, dose, the woman's own goal, and a review date (default 12 weeks).
2. Each week the woman answers a **30-second check-in** with four separate questions: benefit, side effects, adherence, barriers.
3. Before review, the **verdict engine** produces one of a fixed set of verdicts, with the evidence behind it and guideline options for the next step.
4. The clinician reads the verdict, decides, and records the decision. A switch starts the next measured trial.
5. Before irreversible surgery, a **pre-surgery check** shows what was properly tried and her fertility intentions.

**What it never does.** Diagnose, prescribe, rank treatments, or give a fertility score. The clinician always decides.

**v1 channels.** One installable web app (PWA) for women. One web app for clinicians, which also runs embedded inside hospital record systems via SMART on FHIR. Reminders by push, SMS or email carry only a link, never health content.

**Users in v1.** Women aged 18+ (adolescent support is out of scope until a consent model is approved), clinicians, and organisation administrators.

---

## 2. Non-negotiables

These rules override every other section, every deadline, and every request in a PR.

1. **No PHI leaves the user's region** unless a documented legal basis and consent allow it.
2. **No third-party scripts, SDKs, fonts, analytics, advertising, session replay or tracking pixels** in any frontend. Everything is self-hosted.
3. **No PHI in**: logs, error messages, URLs, query strings, push or SMS or email content, analytics events, crash reports, or Git.
4. **Identity data and clinical data live in separate databases** with separate encryption keys.
5. **Deny by default.** Every API route requires authentication and an explicit authorisation policy. A route without a policy fails CI.
6. **Every read or write of health data creates an audit event**, written in the same transaction or a guaranteed outbox.
7. **Phishing-resistant MFA for all clinicians and staff.** No SMS one-time codes for clinician or admin accounts.
8. **No long-lived secrets** in code, CI or developer machines. Use OIDC federation and a secrets manager.
9. **Clinical logic is configuration signed off by clinicians**, versioned, and tested against golden cases. It is never hard-coded ad hoc.
10. **Red flags always win.** No code path may suppress, delay or downgrade a red-flag result.
11. **The woman can export and delete her data** from inside the app at any time.
12. **Hospital integrations fail closed and never block the hospital's own systems.**

---

## 3. Users, roles and permissions

### 3.1 Roles

| Role | Who | Signs in with |
|---|---|---|
| `patient` | The woman | Passkey (WebAuthn); fallback email one-time code |
| `clinician` | Gynaecologist, GP, clinical officer, nurse | Hospital identity provider (OIDC/SAML) via broker, or passkey; MFA mandatory |
| `org_admin` | Clinic manager at a customer organisation | As clinician; MFA mandatory |
| `glucorp_support` | GluCorp support staff | Passkey + hardware key; just-in-time access only; never sees PHI by default |
| `glucorp_platform_admin` | Infrastructure operators | Break-glass only, two-person approval, fully logged |

### 3.2 Permission matrix (v1)

`✓` = allowed, `C` = allowed only with an active consent of the matching purpose, `—` = denied.

| Action | patient | clinician | org_admin | glucorp_support |
|---|---|---|---|---|
| View own episodes and check-ins | ✓ | — | — | — |
| Submit check-in | ✓ (own) | — | — | — |
| Create treatment episode | — | ✓ (own org, consented patient) | — | — |
| View a patient's episodes, check-ins, verdicts | — | C (`share_with_care_team`, same org) | — | — |
| Record review decision | — | C | — | — |
| View pre-surgery check | ✓ (own) | C | — | — |
| Manage clinicians in org | — | — | ✓ | — |
| View aggregate org dashboard (de-identified) | — | ✓ | ✓ | — |
| Export or delete own data | ✓ | — | — | — |
| Access PHI for support | — | — | — | Only with time-boxed patient or org approval ticket, logged |

All checks live in `packages/authz` (Section 10.4) and are tested as a matrix.

---

## 4. Core flows and acceptance criteria

Requirement IDs are stable. Never renumber.

### REQ-001 Patient enrolment
- Clinician creates an enrolment invitation for a patient within their organisation.
- System generates a single-use enrolment link and QR code, valid 7 days, bound to the organisation, not containing any PHI.
- Patient opens link, creates a passkey (or email OTP fallback), reads the consent screen, and accepts or declines each purpose separately (Section 13.1).
- **Acceptance:** link expires after use or 7 days; declined `share_with_care_team` means the clinician sees only "invitation accepted, sharing declined"; all steps audited.

### REQ-002 Start a treatment episode
- Clinician selects treatment (coded), dose, start date, and review interval (default 12 weeks, range 4 to 26).
- Patient sets her goal in her own words, chosen from suggested goals or free text (max 140 chars), and confirms the episode.
- **Acceptance:** an episode is not active until the patient confirms; only one active episode per treatment line; free-text goal stored encrypted (Section 11.3).

### REQ-003 Weekly check-in
- Patient receives a reminder containing only a generic line and a link.
- Check-in takes 30 seconds or less for a typical answer set (measured in usability tests).
- Patient can complete a missed week within 7 days; older weeks are recorded as missing, never imputed.
- Red-flag questions appear every time (Section 6.3).
- **Acceptance:** answers saved atomically with an idempotency key; works offline and syncs later (Section 14); red flag triggers the urgent screen immediately, even offline.

### REQ-004 Verdict generation
- Engine runs on schedule 3 days before the review date and on demand from the clinician view.
- Output stores the verdict, rule set version, input snapshot hash, and explanation trace.
- **Acceptance:** same inputs plus same rule version always produce the same output; golden tests pass.

### REQ-005 Clinician review
- Review queue lists episodes due within 14 days, sorted by due date, red flags pinned on top.
- Clinician sees verdict, evidence, guideline options, and records a decision (continue, switch, add, refer, stop) with optional note.
- **Acceptance:** decision is required to close the review; a "switch" opens a pre-filled new episode draft; full keyboard operation.

### REQ-006 Pre-surgery check
- When a clinician marks "considering surgery" (hysterectomy, myomectomy, ovarian cystectomy, adenomyomectomy, ablation), the system shows treatments properly tried, not properly tried (with reason), never tried from the guideline option list, and stated fertility intentions.
- **Acceptance:** clinician must acknowledge the check before the surgery intention is saved; the check is visible to the patient.

### REQ-007 Red-flag handling
- Any red-flag answer shows the urgent-care screen with local emergency guidance and, where configured, notifies the care team.
- **Acceptance:** cannot be dismissed without acknowledging; works offline with cached local emergency number; notification never includes PHI.

### REQ-008 Patient treatment history
- Patient sees all her episodes as Trial Cards (Section 21.6) and can share a read-only summary via a time-limited link (default 7 days, revocable) or a printable PDF generated on device.

### REQ-009 Data rights
- Export: complete machine-readable export (FHIR Bundle JSON) plus human-readable PDF.
- Delete: account deletion with 14-day grace period, then hard deletion from primary stores and crypto-shredding of her per-patient data key; backups expire on their normal schedule.
- **Acceptance:** deletion job verified by automated test; audit entry retained without PHI.

### REQ-010 Organisation admin
- Invite and remove clinicians; set review interval defaults, languages, local emergency number, record-system integration settings.

### REQ-011 Aggregate dashboard
- De-identified counts only: episodes started, reviews completed on time, verdict distribution, median weeks on ineffective treatment. Minimum cell size 10; smaller cells suppressed.

---

## 5. Domain model and FHIR mapping

### 5.1 Entities (clinical database)

All IDs are UUIDv7. All timestamps UTC with timezone stored separately where clinically relevant. No names, phone numbers, emails or addresses in the clinical database.

```
Organization        id, region, name, settings(jsonb), created_at
Clinician           id, org_id, identity_ref, role, active, created_at
PatientRecord       id (pseudonym), org_id, identity_ref (opaque pointer to identity vault),
                    birth_year, preferred_language, created_at
Consent             id, patient_id, purpose, status(granted|revoked), version, granted_at, revoked_at
TreatmentEpisode    id, patient_id, org_id, prescriber_id, treatment_code, treatment_system,
                    dose_text, start_date, review_date, review_interval_weeks,
                    status(draft|active|in_review|closed), goal_id, previous_episode_id
Goal                id, patient_id, episode_id, text_encrypted, goal_template_code
CheckIn             id, episode_id, week_index, submitted_at, client_created_at,
                    idempotency_key, answers(jsonb validated), is_late
RedFlagEvent        id, patient_id, checkin_id, flags[], shown_at, acknowledged_at, team_notified_at
Verdict             id, episode_id, verdict_code, ruleset_version, input_hash,
                    explanation(jsonb), generated_at, generated_by(system|on_demand)
ReviewDecision      id, episode_id, verdict_id, clinician_id, decision_code, note_encrypted,
                    next_episode_id, decided_at
SurgeryCheck        id, patient_id, clinician_id, procedure_code, snapshot(jsonb),
                    acknowledged_at
ShareLink           id, patient_id, scope, token_hash, expires_at, revoked_at
AuditEvent          (separate append-only store, Section 12.9)
```

### 5.2 Identity database (identity vault)

```
Person              id, identity_provider_subject, email_encrypted, phone_encrypted,
                    display_name_encrypted, created_at, deleted_at
PatientLink         person_id, patient_record_id, org_id
```

Only the identity service can read this database. The API never joins across databases; it calls the identity service for display data, and only when the caller is authorised.

### 5.3 FHIR R4 mapping

| Domain entity | FHIR resource | Key codings |
|---|---|---|
| PatientRecord | Patient (pseudonymous; identity added only at an authorised integration boundary) | — |
| TreatmentEpisode | CarePlan (status, period, activity → MedicationRequest/Procedure) | SNOMED CT for condition |
| Goal | Goal | SNOMED CT where a template applies |
| Treatment | MedicationStatement / MedicationRequest; Procedure (coils, surgery) | RxNorm (US), dm+d (UK), ATC; SNOMED CT procedures |
| CheckIn | QuestionnaireResponse against a canonical Questionnaire | LOINC where validated items exist |
| Scores | Observation | LOINC, UCUM |
| Verdict | Observation (code from GluCorp code system, derivedFrom the QuestionnaireResponses) | `https://fhir.glucorp.health/CodeSystem/verdict` |
| ReviewDecision | Task + CarePlan update | — |
| Consent | Consent | — |
| AuditEvent | AuditEvent | — |

Publish an Implementation Guide written in FSH (FHIR Shorthand) under `fhir/ig/`, built with SUSHI and the IG Publisher in CI. Every outbound resource is validated against the IG with the official HL7 validator in CI and at runtime in non-production.

---

## 6. The check-in instrument

All wording lives in `clinical/instrument/checkin.v1.yaml` and requires clinical sign-off. The structure below is fixed; wording and scales are `TODO_CLINICAL` until approved.

### 6.1 Weekly questions (order fixed)

| ID | Domain | Question (draft) | Answer type |
|---|---|---|---|
| Q1 | Benefit | "On your worst day this week, how bad was the pain?" | 0–10 scale with word anchors (0 no pain, 10 worst imaginable) |
| Q2 | Benefit | "Did pain or bleeding stop you doing what you planned?" | none / some days / most days / every day |
| Q3 | Benefit (goal) | "This week, did you manage: {goal}?" | yes / partly / no / didn't apply this week |
| Q4 | Bleeding | "How heavy was your bleeding?" (only if bleeding toggled) | pictorial scale, TODO_CLINICAL (validated chart) |
| Q5 | Side effects | "Did you notice any side effects?" | multi-select from treatment-specific list + "other" |
| Q6 | Side effects | "How much did side effects bother you?" (if any) | not at all / a little / a lot / unbearable |
| Q7 | Adherence | "On how many days did you take it as prescribed?" | 0–7 (pills); for coils/injections replaced by "Is it still in place / did you get the injection?" |
| Q8 | Barriers | "Did anything get in the way?" | none / forgot / side effects / cost / ran out / couldn't get to clinic / other |

### 6.2 Review-week additions (at weeks 4, 8, 12)

EHP-5 (licensed instrument; check licence before use, `TODO_LICENCE`) and a global impression of change ("Compared with before this treatment, how are you?" 7-point scale).

### 6.3 Red-flag screen (every check-in, cannot be skipped)

`TODO_CLINICAL` final list. Draft:
- Soaking through a pad or tampon in an hour or less, for two hours or more
- Fainting, or feeling faint and dizzy
- Sudden severe pain in the abdomen or pelvis
- Fever with pelvic pain
- Pain with a possible pregnancy
- Thoughts of harming yourself (routes to locally configured crisis support)

---

## 7. The verdict engine

`packages/verdict` is a pure, deterministic TypeScript library: no I/O, no clock, no randomness. It takes an input snapshot and a rule set and returns a verdict with an explanation trace.

### 7.1 Verdict codes

| Code | Meaning shown to clinician |
|---|---|
| `RED_FLAG` | Red flag reported during this trial; see events |
| `INSUFFICIENT_DATA` | Not enough check-ins to judge |
| `NOT_TAKEN_ENOUGH` | Taken on too few days to judge; reasons listed |
| `NOT_TOLERATED` | Side effects she rated unacceptable |
| `NOT_WORKING` | Taken properly, no meaningful benefit |
| `PARTLY_WORKING` | Some benefit, goal not consistently met |
| `WORKING` | Meaningful benefit and goal met |

A verdict may carry modifiers, for example `PARTLY_WORKING` + `SIDE_EFFECTS_LIMITING`.

### 7.2 Algorithm (order is fixed)

```
evaluate(snapshot, ruleset):
  trace = []
  if any red flag in snapshot.checkins:            return RED_FLAG (+ continue evaluating, attach result as secondary)
  if count(valid checkins) < R.min_checkins:       return INSUFFICIENT_DATA
  if adherence_ratio < R.adherence_threshold:      return NOT_TAKEN_ENOUGH (with barrier breakdown)
  if unbearable_side_effects_weeks >= R.intolerance_weeks
     or patient_reported_stop_due_to_side_effects: return NOT_TOLERATED
  benefit = compare(baseline window, recent window) on Q1, Q2, Q3
  if benefit >= R.meaningful_improvement and goal_met_ratio >= R.goal_met_threshold: WORKING
  elif benefit > R.minimal_change:                 PARTLY_WORKING
  else:                                            NOT_WORKING
  add modifiers (SIDE_EFFECTS_LIMITING, BARRIER_COST, BARRIER_STOCKOUT, DATA_GAPS)
```

Every step appends to `trace` with the values compared and the threshold used, so the UI can show "why this verdict".

### 7.3 Rule set configuration

`clinical/rulesets/ruleset.<version>.yaml`, validated by a JSON Schema, signed (Section 18.5).

```yaml
version: 1.0.0
approved_by: TODO_CLINICAL          # name and role of clinical lead
approved_on: TODO_CLINICAL
evidence: docs/clinical/ruleset-1.0.0-rationale.md
thresholds:
  min_checkins: TODO_CLINICAL        # draft: 8 of 12 weeks
  adherence_threshold: TODO_CLINICAL # draft: 0.8
  intolerance_weeks: TODO_CLINICAL   # draft: 2 weeks rated "unbearable"
  baseline_window_weeks: TODO_CLINICAL
  recent_window_weeks: TODO_CLINICAL
  meaningful_improvement: TODO_CLINICAL # draft: 30% reduction in worst pain or 2 points
  minimal_change: TODO_CLINICAL
  goal_met_threshold: TODO_CLINICAL
guideline_options:                   # per verdict and treatment class, with source citations
  TODO_CLINICAL
```

The build must refuse to start in staging or production if any `TODO_CLINICAL` remains in the active rule set.

### 7.4 Testing

- **Golden cases:** `clinical/golden/*.yaml`, at least 60 synthetic patients covering every verdict and boundary, with the expected verdict signed off by the clinical lead.
- **Property tests:** determinism, monotonicity (more adherence never makes `NOT_TAKEN_ENOUGH` more likely), red-flag dominance.
- **Shadow mode:** before verdicts are used in care, they are generated and compared against clinician judgement without being shown (milestone M3).

---

## 8. Architecture and technology choices

### 8.1 Principles

- TypeScript end to end, one monorepo, strict types.
- Boring, well-maintained technology. Few dependencies.
- Portable: everything runs in containers with Terraform modules, so it can be deployed in AWS regions and in Kenya and Rwanda data centres.
- Cloud-specific services sit behind interfaces (`KeyManager`, `ObjectStore`, `Mailer`, `SmsSender`, `PushSender`).

### 8.2 Components

```
apps/
  patient-web/        Woman's PWA (React, Vite)
  clinic-web/         Clinician app: standalone portal + SMART on FHIR launch (React, Vite)
services/
  bff-patient/        Backend-for-frontend for patient-web: sessions, CSRF, token handling
  bff-clinic/         Backend-for-frontend for clinic-web, including SMART launch
  api/                Core domain API (episodes, check-ins, reviews, consent, audit)
  identity/           Identity vault service; only component touching the identity DB
  integration/        FHIR facade and outbound connectors to record systems
  reminders/          Scheduling and sending of link-only reminders
  jobs/               Verdict scheduling, retention, deletion, exports
packages/
  domain/             Types, value objects, invariants
  verdict/            Pure verdict engine
  authz/              Authorisation policies and matrix tests
  fhir/               FHIR types, mappers, validators
  ui/                 Design system: tokens, components, Trial Strip
  i18n/               Messages and locale tooling
  crypto/             Envelope encryption helpers wrapping KMS (no custom crypto)
  audit/              Audit event writer and schema
  config/             Typed, validated configuration
clinical/             Instrument, rule sets, golden cases (clinician-owned)
fhir/ig/              Implementation Guide (FSH)
infra/                Terraform modules and environment stacks
docs/                 ADRs, threat model, runbooks, clinical rationale
```

### 8.3 Technology choices

Pin every version at build time to the current stable or LTS release and record it in `docs/adr/0002-baseline-versions.md`.

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | One language, strong typing |
| Runtime | Node.js LTS | Stable, well understood |
| HTTP framework | Fastify | Fast, schema-first, small |
| Validation | Zod at every boundary; JSON Schema for OpenAPI | Reject bad input early |
| Database | PostgreSQL (two clusters: clinical, identity; separate audit store) | Mature, row-level security, JSONB |
| Data access | Kysely (typed SQL query builder) with hand-written, reviewed SQL migrations | SQL stays visible and reviewable |
| Jobs and queue | pg-boss on PostgreSQL | No extra infrastructure; portable |
| Identity provider | Keycloak (one realm per region) | OIDC, SAML brokering, WebAuthn, self-hostable |
| Frontend | React + Vite, TanStack Router and Query | Mature, fast builds |
| UI primitives | Radix UI primitives (unstyled), styled only with our tokens | Accessible behaviour, our own look |
| Styling | CSS Modules + CSS custom properties from `packages/ui/tokens` | No framework defaults leaking into the look |
| Charts | Hand-built SVG components (Trial Strip, sparklines) | No chart dependency; exact control |
| i18n | FormatJS (ICU messages) | Plurals, RTL readiness |
| Monorepo | pnpm workspaces + Turborepo | Strict dependency isolation |
| Testing | Vitest, Testcontainers, Playwright, axe-core, fast-check | Section 19 |
| FHIR | `@types/fhir` (or Medplum FHIR types), HL7 validator, SUSHI | Standard tooling |
| Infrastructure as code | Terraform (OpenTofu compatible) | Portable |
| Containers | Distroless or minimal base images, non-root, read-only filesystem | Small attack surface |

### 8.4 Request flow

```
Browser (patient-web)  ──HTTPS──>  bff-patient  ──mTLS + service token──>  api  ──>  clinical DB
                                        │                                    │
                                        └────────> identity ──> identity DB  └──> audit store
Record system (Epic etc.) ──SMART launch──> bff-clinic ──> api
Record system <──FHIR R4── integration ──> api
```

- Browsers never hold access tokens. The BFF keeps tokens server-side and issues an `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` session cookie.
- Service-to-service calls use mutual TLS and short-lived signed service tokens with audience restriction.

---

## 9. API design

### 9.1 Conventions

- REST over HTTPS, JSON, OpenAPI 3.1 spec in `services/api/openapi.yaml` generated from Zod schemas and committed.
- Versioned under `/v1`. Breaking changes require `/v2` and a deprecation period of at least 6 months.
- All mutating requests require an `Idempotency-Key` header (UUID). Replays return the original response.
- Errors use RFC 9457 problem details. Error bodies never echo submitted health data.
- Cursor-based pagination (`?cursor=…&limit=…`, max 100).
- Every request carries a `traceparent` header (W3C Trace Context).
- No PHI or identifiers that reveal PHI in paths or query strings. Use opaque IDs only.

### 9.2 Core endpoints (v1)

```
POST   /v1/enrolments                       clinician: create invitation
POST   /v1/enrolments/{token}/accept        patient: accept, consents
GET    /v1/me/episodes                      patient
POST   /v1/episodes                         clinician: draft episode
POST   /v1/episodes/{id}/confirm            patient: set goal, confirm
POST   /v1/episodes/{id}/checkins           patient: submit (idempotent)
GET    /v1/episodes/{id}                    patient (own) or clinician (consented)
GET    /v1/reviews/queue                    clinician
POST   /v1/episodes/{id}/verdict:generate   clinician (on demand)
POST   /v1/episodes/{id}/decision           clinician
POST   /v1/patients/{id}/surgery-checks     clinician
GET    /v1/me/consents  PUT /v1/me/consents/{purpose}
POST   /v1/me/share-links  DELETE /v1/me/share-links/{id}
POST   /v1/me/export  POST /v1/me/deletion
GET    /v1/orgs/{id}/dashboard              clinician, org_admin (aggregate)
```

### 9.3 FHIR API (integration service)

`/fhir/r4/` exposing read and search for Patient (pseudonymous), CarePlan, Goal, QuestionnaireResponse, Observation, Consent; `metadata` capability statement; SMART configuration at `/.well-known/smart-configuration`. Write operations from external systems are limited to MedicationRequest ingestion in later phases.

---

## 10. Identity, authentication and authorisation

### 10.1 Patients

- Primary: passkeys (WebAuthn, platform authenticators). Prompt to create a passkey at enrolment.
- Fallback: email one-time code (6 digits, 10-minute expiry, rate-limited). SMS one-time code only where email is impractical, and never as the only factor for account recovery.
- Session: 30 minutes idle timeout, 12 hours absolute; re-authentication for export, deletion, share-link creation and consent changes.
- App lock: optional local PIN or biometric lock for shared phones (WebAuthn user verification).

### 10.2 Clinicians and admins

- Federated sign-in via the hospital identity provider (OIDC or SAML through Keycloak brokering), or passkeys for organisations without one.
- MFA mandatory and phishing-resistant (passkeys or hardware keys). Brokered logins must assert MFA (`amr`/`acr` claims) or Keycloak enforces a second factor.
- Session: 15 minutes idle in standalone portal; follows the record system's session when embedded.

### 10.3 GluCorp staff

- Hardware security keys only. No standing access to production data. Just-in-time elevation through an approval workflow, time-boxed (maximum 4 hours), recorded and reviewed weekly.

### 10.4 Authorisation

- `packages/authz` exports pure policy functions: `can(subject, action, resource, context) -> Allow | Deny(reason)`.
- Context includes consent state, organisation membership, and care-team relationship.
- Every API route declares its policy in a route definition; a CI check fails if any route lacks one.
- PostgreSQL row-level security enforces organisation isolation as a second layer (session variable `app.org_id` set per transaction).
- The permission matrix in Section 3.2 is encoded as a table-driven test that must pass for every role and action.

---

## 11. Data storage and encryption

### 11.1 Stores per region

| Store | Contents | Key |
|---|---|---|
| Identity DB | Names, emails, phones, IdP subjects | `kms/identity` |
| Clinical DB | Pseudonymous clinical data | `kms/clinical` |
| Audit store | Append-only audit events (no free text) | `kms/audit` |
| Object store | Exports and PDFs (short-lived, 24h expiry) | `kms/objects` |
| Analytics DB | De-identified aggregates only | `kms/analytics` |
| Backups | Encrypted, immutable (object lock), separate account | `kms/backup` |

### 11.2 Encryption

- In transit: TLS 1.3 only externally; mutual TLS internally.
- At rest: storage-level encryption with customer-managed KMS keys per store and region.
- Field-level envelope encryption (AES-256-GCM via KMS-generated data keys, through `packages/crypto`) for free-text fields: goal text, decision notes, "other" answers, and identity fields.
- **Per-patient data keys** for field-level encryption, enabling crypto-shredding on deletion.
- Keys rotated yearly or on suspicion of compromise. No application code ever sees a master key.
- Never implement cryptographic primitives. Use KMS, Node's `crypto` module, and WebCrypto only.

### 11.3 Data minimisation in the schema

Every column has an entry in `docs/data-inventory.md` stating purpose, legal basis, retention, and sensitivity. A CI check compares migrations against the inventory and fails on undocumented columns.

### 11.4 Retention (defaults, configurable per region after legal review)

- Active clinical data: while the account is active plus the legally required clinical-record period for the region (`TODO_LEGAL`).
- Audit events: 7 years (no PHI inside).
- Exports and PDFs: 24 hours.
- Share links: expire as set, maximum 30 days.
- Deleted accounts: hard delete after 14-day grace; per-patient keys destroyed immediately at hard delete.

---

## 12. Security engineering

Built to OWASP ASVS 5.0 Level 2 (Level 3 for authentication, session and crypto controls), OWASP MASVS principles for the PWA, IEC 81001-5-1 for the lifecycle, and mapped to ISO 27001 Annex A.

### 12.1 Threat model

Maintained in `docs/threat-model.md` using STRIDE per component and data flow, reviewed every release. Starting entries:

| ID | Threat | Example | Primary controls |
|---|---|---|---|
| RISK-S01 | Spoofing | Stolen clinician password | Phishing-resistant MFA, federated IdP, session binding |
| RISK-S02 | Spoofing | Someone else on a shared phone opens her app | App lock, idle timeout, quick exit, no PHI in notifications |
| RISK-T01 | Tampering | Altered rule set changes verdicts | Signed rule sets, verification at startup, two-person approval |
| RISK-T02 | Tampering | Malicious dependency in build | Supply-chain controls (12.4) |
| RISK-R01 | Repudiation | Clinician disputes a decision | Append-only, hash-chained audit log |
| RISK-I01 | Information disclosure | Clinical DB exfiltrated | Pseudonymisation, separate identity vault, field-level encryption |
| RISK-I02 | Information disclosure | PHI in logs or error trackers | Log schema allowlist, redaction tests, no third-party error tracker with PHI |
| RISK-I03 | Information disclosure | Cross-organisation data leak | authz policies + row-level security + tests |
| RISK-I04 | Information disclosure | Legal demand for reproductive data | Minimisation, regional hosting, legal request policy, transparency report |
| RISK-D01 | Denial of service | Bot floods check-in endpoint | WAF, rate limits per user and IP, idempotency |
| RISK-D02 | Ransomware | Encryption of production | Immutable offline backups, separate backup account, tested restores |
| RISK-E01 | Elevation of privilege | Support staff accessing PHI | Just-in-time access, approvals, alerts |
| RISK-E02 | Elevation of privilege | Compromised record-system integration | Per-integration credentials, least scopes, kill switch |
| RISK-C01 | Clinical | False "working" verdict delays care | Conservative thresholds, clinician decides, shadow mode, post-market monitoring |
| RISK-C02 | Clinical | Red flag missed | Red flags on every check-in, offline handling, tests |

### 12.2 Web hardening (both frontends)

- `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'`.
- `clinic-web` when embedded: `frame-ancestors` set per organisation to the exact record-system origins configured by `org_admin`.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy` (camera, microphone, geolocation, payment denied).
- Trusted Types enforced. No `dangerouslySetInnerHTML`. Lint rule bans it.
- CSRF: `SameSite=Strict` cookies plus a synchronizer token on mutating requests.
- Subresource Integrity for every static asset.
- Fonts, icons and images self-hosted.

### 12.3 API hardening

- Input validation with Zod on every route; reject unknown fields.
- Output encoding; JSON only.
- Rate limits: per IP, per session, per account, per endpoint class; stricter on auth endpoints. Lockout with exponential backoff.
- Request size limits (100 KB default).
- Timeouts on every outbound call; circuit breakers on integrations.
- SSRF protection: the integration service only calls allowlisted hosts per organisation.

### 12.4 Software supply chain

- `pnpm install --frozen-lockfile` in CI. Lockfile changes require review.
- **Minimum release age** for new dependency versions (at least 7 days) configured in pnpm and Renovate, so freshly published malicious versions are not pulled in.
- Install scripts disabled by default; only an explicit allowlist of packages may run build scripts.
- Renovate weekly, grouped, with changelog review. No auto-merge for runtime dependencies.
- GitHub Actions pinned to full commit SHAs. Minimal `permissions:` per workflow.
- Cloud access from CI via OIDC federation only. No static cloud keys anywhere.
- SBOM (CycloneDX) for every build artefact; stored with the release.
- Container images signed with Sigstore cosign; provenance attestations (SLSA level 3 target); deploys verify signatures and refuse unsigned images.
- Scans: CodeQL and Semgrep (code), gitleaks (secrets, also as pre-commit hook), Trivy (containers and IaC), OSV-Scanner (dependencies), OWASP ZAP baseline (staging).
- Branch protection: two approvals for `main`, CODEOWNERS for `packages/authz`, `packages/crypto`, `packages/verdict`, `clinical/`, `infra/`. Signed commits required.

### 12.5 Secrets

- Stored in the cloud secrets manager (or HashiCorp Vault in non-AWS regions). Fetched at startup via workload identity.
- Never in environment files committed to Git. `.env.example` contains names only.
- Rotation runbook for every secret type.

### 12.6 Runtime

- Containers run as non-root with read-only root filesystems, dropped Linux capabilities, and seccomp default profiles.
- Private subnets for all services and databases; only the load balancer is public, behind a web application firewall.
- Egress restricted to known destinations.
- Production access only through audited, just-in-time sessions.

### 12.7 Security testing cadence

- Every PR: static scans, dependency scans, secret scans, authz matrix tests.
- Every release candidate: DAST against staging, IaC scan.
- Before pilot and then yearly: external penetration test (web, API, infrastructure, SMART integration). Findings tracked to closure.
- From launch: public vulnerability disclosure policy at `/.well-known/security.txt`; bug bounty once the product is stable.

### 12.8 Backup and recovery

- Point-in-time recovery on databases; daily encrypted snapshots copied to a separate backup account with object lock (immutable for 35 days).
- Targets: recovery point objective 15 minutes, recovery time objective 4 hours (to confirm with customers).
- Restore drills every quarter, with a written report.

### 12.9 Audit log

- Every access to health data writes an `AuditEvent`: actor, role, action, resource type and opaque ID, purpose of use, outcome, timestamp, request ID. Never content.
- Append-only store; each event includes the hash of the previous event (hash chain). Daily anchor hash published to a separate write-once bucket.
- Patients can see who accessed their record (REQ-008 extension, milestone M4).
- Alerts: unusual volume of record reads, access outside working hours by support, repeated denied requests.

### 12.10 Incident response

- Runbook in `docs/runbooks/incident-response.md`: severity levels, roles, communication templates.
- Regulatory notification clocks built into the runbook: 72 hours to the supervisory authority under GDPR and Kenya's Data Protection Act; HIPAA notification without unreasonable delay and within 60 days; others per region (`TODO_LEGAL`).
- Tabletop exercise twice a year, including a ransomware scenario and a compromised-integration scenario.

### 12.11 Rules for AI-assisted development

- AI coding tools never receive real patient data, production secrets, or production logs.
- Generated code is reviewed by a human before merge like any other code.
- Security-sensitive packages (`authz`, `crypto`, `audit`, `verdict`, auth flows) require a named human reviewer.

---

## 13. Privacy features

### 13.1 Consent purposes

| Purpose | Default | Effect if declined |
|---|---|---|
| `self_tracking` | Required to use the app | No account |
| `share_with_care_team` | Asked, not pre-ticked | Clinician cannot see her data |
| `research_deidentified` | Asked separately, not pre-ticked | Excluded from research datasets |
| `org_aggregate_reporting` | Asked separately | Excluded from org dashboard counts |

Each purpose has its own plain-language explanation (reading age about 11), version number and timestamp. Withdrawing consent takes effect immediately.

### 13.2 Shared-phone and safety design

- **Quick exit:** a persistent, clearly labelled button that immediately replaces the screen with a neutral page, clears the session and in-memory state.
- **Neutral app name and icon option:** the installed PWA can display a neutral name (for example "Weekly check-in") chosen at install.
- **No health content in notifications, page titles, or browser history.** Page titles are generic.
- **App lock** (Section 10.1).

### 13.3 Rights

Export, correction requests, deletion (REQ-009), access log view, and a contact route to the data protection officer, all reachable within two taps from settings.

### 13.4 Legal requests

A published policy: disclose only under valid legal compulsion, challenge overbroad requests, notify the user where lawful, and publish a yearly transparency report.

---

## 14. The web app (PWA) specifics

- Installable PWA with a web app manifest; works on current versions of Chrome, Safari (iOS 16.4+ for web push), Samsung Internet and Firefox.
- **Performance budget:** first load under 150 KB of JavaScript (compressed) on the check-in route; interactive within 3 seconds on a mid-range Android phone over 3G (test with Lighthouse throttling).
- **Service worker caching rules:** cache the app shell, fonts and static assets only. Never cache API responses containing PHI.
- **Offline check-ins:** answers queued in IndexedDB, encrypted with a non-extractable WebCrypto AES-GCM key created per session; queue cleared on sign-out; synced with idempotency keys when online.
- **Red flags offline:** the urgent-care screen and the organisation's emergency number are part of the cached shell.
- Web Push (VAPID) payloads contain only a generic message; the app fetches content after sign-in.

---

## 15. Reminder service

- Channels: web push, email, SMS (order of preference set by the patient).
- Templates live in `services/reminders/templates/`, reviewed for PHI. Only generic text and a link, for example: "Your weekly check-in is ready." No names, conditions, treatments or clinic names in SMS.
- Links are short-lived, single-purpose, and require sign-in; they contain no identifiers beyond an opaque token.
- Send windows respect the patient's chosen time and quiet hours.
- Providers sit behind interfaces with data-processing agreements. WhatsApp is not used in v1.

---

## 16. Integration service (FHIR, SMART on FHIR)

### 16.1 Standalone first

Every organisation can use the clinician portal with no record-system integration. Integration is added per pilot site.

### 16.2 SMART on FHIR (embedded clinician view)

- Supports SMART App Launch 2.x (EHR launch with PKCE), scopes limited to the patient in context.
- `bff-clinic` completes the OAuth flow server-side; tokens never reach the browser.
- Patient matching: the record system's patient ID is mapped to our pseudonymous record through an explicit link created at enrolment, never by name or date-of-birth matching alone.
- Development and testing against the SMART Health IT launcher and the Epic on FHIR public sandbox.

### 16.3 Backend services

- SMART Backend Services (asymmetric client authentication, short-lived tokens) for system-to-system calls.
- Each organisation's integration has its own credentials, scopes and an admin kill switch.

### 16.4 Outbound data

- Verdict summary written back as a FHIR Observation and a PDF DocumentReference (where the receiving system supports it), only with `share_with_care_team` consent.
- Writes are queued, retried with backoff, and dead-lettered with alerts; failures never affect the portal.

### 16.5 Conformance

- Inferno (ONC test kit) for SMART and FHIR API conformance in CI on every release.
- Participation in an HL7 Connectathon before the first US or European hospital integration.

---

## 17. Infrastructure

### 17.1 Environments

`dev` (synthetic data only) → `staging` (synthetic data, production-like) → `production` (per region). Separate cloud accounts per environment and per region. Backups in a separate account.

### 17.2 Reference deployment (AWS, per region)

- Application Load Balancer + AWS WAF.
- ECS Fargate services in private subnets (or Kubernetes where the region requires it).
- RDS PostgreSQL (Multi-AZ) for clinical and identity databases, separate instances.
- KMS customer-managed keys per store; Secrets Manager.
- S3 with object lock for backups and short-lived exports.
- CloudTrail, GuardDuty, Security Hub, VPC flow logs to a separate logging account.
- Regions: EU (Frankfurt), UK (London), US (as required by the first US customer).

### 17.3 Kenya and Rwanda

Health-data localisation requires in-country hosting. Terraform modules must also target a Kubernetes distribution (for example k3s or a local managed Kubernetes) in a certified local data centre, with PostgreSQL, Keycloak, HashiCorp Vault (with an HSM where available) and MinIO with object lock replacing the AWS-managed services. The `KeyManager` and `ObjectStore` interfaces make this a deployment choice, not a code change.

### 17.4 Infrastructure rules

- Everything in Terraform; no manual changes in consoles (drift detection weekly).
- Policy-as-code checks (for example Checkov or OPA Conftest) block public buckets, unencrypted stores, open security groups.

---

## 18. Software development lifecycle, CI/CD and traceability

### 18.1 Branching and reviews

- Trunk-based development on `main`, short-lived branches, squash merges.
- Two approvals for all PRs; one must be a CODEOWNER for protected paths.
- PR template includes: requirement IDs, risk IDs, threat note, test evidence, screenshots for UI, data inventory changes.

### 18.2 Required CI checks

Type check, lint (including security lint rules), unit tests, integration tests (Testcontainers), authz matrix test, verdict golden tests, FHIR validation, OpenAPI diff (breaking change detection), accessibility tests, bundle size budget, CodeQL, Semgrep, gitleaks, OSV-Scanner, Trivy, IaC policy checks, SBOM generation, licence check (allowlist: MIT, Apache-2.0, BSD, ISC, MPL-2.0 after review).

### 18.3 Release

- Semantic versioning per deployable.
- Release candidates deployed to staging, DAST run, smoke tests, then manual approval to production.
- Database migrations are backward compatible (expand, migrate, contract). Every migration has a tested rollback plan.
- Feature flags (server-side, our own simple implementation in `packages/config`) for gradual rollout; flags never bypass security controls.

### 18.4 Traceability (IEC 62304 readiness)

- Requirements in `docs/requirements/` with IDs (`REQ-…`), risks in `docs/risk/` (`RISK-…`) following ISO 14971.
- Tests tag the requirements and risks they verify (`describe('REQ-003 …')`).
- A script generates the traceability matrix (requirement → design → code → test → result) for every release and stores it with the release artefacts.
- Software of Unknown Provenance (SOUP) list generated from the SBOM, with risk assessment for each runtime dependency.

### 18.5 Clinical change control

- Changes to `clinical/` require: the clinical lead's approval, an updated rationale document, regenerated golden test results, and a signed rule set (signature verified by the services at startup with a public key held in configuration).
- Rule set version and instrument version appear in every verdict and every check-in.

---

## 19. Testing strategy

1. **Unit tests** (Vitest) for domain, verdict, authz, crypto wrappers, mappers.
2. **Property-based tests** (fast-check) for the verdict engine and authorisation.
3. **Integration tests** with real PostgreSQL and Keycloak in Testcontainers.
4. **Contract tests** for the FHIR API against the Implementation Guide; OpenAPI schema tests.
5. **End-to-end tests** (Playwright) for enrolment, check-in (online and offline), red flag, review, surgery check, export, deletion, quick exit; run on Chromium and WebKit, with mobile viewports.
6. **Synthetic data generator** (`tools/synthea-endo/`) producing realistic patients, treatments and check-in histories, including edge cases (missing weeks, cost barriers, red flags). Optionally seeded from Synthea for demographics.
7. **Accessibility tests:** axe-core in unit and e2e tests; manual screen-reader passes (VoiceOver, TalkBack, NVDA) each milestone.
8. **Security tests:** authz matrix; tests that assert no PHI appears in logs (log capture during e2e, scanned for synthetic PHI markers); CSP violation tests; rate-limit tests.
9. **Load tests** (k6): 10,000 check-ins per hour per region with p95 under 300 ms.
10. **Usability tests** with women and clinicians each milestone (IEC 62366 formative evaluation); check-in completion time measured.

---

## 20. Observability

- OpenTelemetry for traces, metrics and logs, exported to a self-hosted or region-pinned backend (Grafana stack or the cloud's native service in-region).
- **Structured logs with an allowlist schema:** only approved fields can be logged; anything else is dropped. Opaque IDs only.
- Error tracking self-hosted; payload scrubbing enforced and tested.
- Service level objectives: API availability 99.9%, check-in submission success 99.95%, verdict generation before review date 99.9%.
- Dashboards and alerts for: authentication failures, denied authorisation spikes, red-flag notification delivery, integration failures, job backlogs, backup success.

---

## 21. Design system and UI

### 21.1 The idea

Most health apps look the same: soft pastels, rounded cards, cheerful illustrations, a wellness-app calm. Ours should feel like a **well-made instrument and a private notebook**: precise, quiet, honest about uncertainty, and respectful of someone in pain. The reference points are physical, not other apps: a lab specimen label, a paper treatment diary with ruled columns, a pharmacist's dosing card, a railway timetable. Information is set in clear type on ruled surfaces, not floated in bubbles.

Interaction references worth studying (study, never copy): the keyboard-first density of Linear for the clinician desk; the plain-language rigour and accessibility of the NHS design system; the one-tap logging of Apple Health's medications; the calm of a paper planner.

**The one memorable element is the Trial Strip** (21.6). Everything else stays quiet so it can carry the product.

### 21.2 Principles

1. **One thing per screen for the woman.** One question, one answer, one button. Large type, large targets, thumb-reachable.
2. **Show the evidence, not a score.** Never collapse the four signals into one number or a traffic light.
3. **Words before colour.** Every state has a word and a shape; colour supports, never carries meaning alone.
4. **No guilt, no games.** No streaks, badges, confetti, or "you missed a day!" scolding. A missed week is shown neutrally.
5. **Density for clinicians, calm for women.** Same system, two tempos.
6. **Honest uncertainty.** "Not enough data to judge" is a first-class state with its own design, not an error.
7. **Fast on cheap phones.** No heavy imagery, no animation libraries, system-like speed.

### 21.3 Typography

- **UI and body:** Atkinson Hyperlegible Next (designed by the Braille Institute for legibility; distinct letterforms help people reading in pain, tired, or on small screens). Self-hosted, variable weights.
- **Verdict words and section titles:** Literata (a reading serif with a large language coverage). Used sparingly: the verdict sentence, the woman's goal, page titles.
- **Numbers:** tabular figures from Atkinson Hyperlegible Next for scores, days and dates so columns align.
- **Scale (rem, base 16 px):** 0.8125 / 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.25. Line height 1.5 for body, 1.2 for titles. Line length capped at 66 characters.
- Sentence case everywhere. No all-caps labels. No letter-spaced eyebrows.
- Script coverage: verify Swahili and Kinyarwanda diacritics and plan an Arabic companion face (for example IBM Plex Sans Arabic) for RTL markets.

### 21.4 Colour

Cool, mineral, low saturation. Each lane of the Trial Strip has its own hue, chosen to stay distinguishable for the common forms of colour blindness and always paired with a label and pattern.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--surface` | #F2F4F3 (chalk) | #151918 | Page |
| `--surface-raised` | #FFFFFF | #1D2221 | Panels, sheets |
| `--ink` | #1E2422 (basalt) | #E7ECEA | Primary text |
| `--ink-muted` | #56625E | #A3AFAB | Secondary text |
| `--rule` | #D3D9D6 | #2E3533 | Ruled lines, dividers |
| `--action` | #0E5A52 (deep spruce) | #5FC2B5 | Primary buttons, links, focus |
| `--lane-benefit` | #2E6B4A (moss) | #6FC79A | Benefit lane |
| `--lane-side-effects` | #8A5A08 (ochre) | #E3B04F | Side-effects lane |
| `--lane-taken` | #34508F (slate blue) | #8EA8E8 | Adherence lane |
| `--lane-barriers` | #6A4F86 (heather) | #BBA2D8 | Barriers lane |
| `--critical` | #A0102C | #FF7A8F | Red flags only |
| `--focus-ring` | #0E5A52 at 3 px with 2 px offset | #5FC2B5 | Keyboard focus |

Rules: `--critical` is reserved for red flags and nothing else. No gradients. No pink or lavender "femtech" palette. All text pairs meet WCAG 2.2 AA (4.5:1), and large verdict text meets AAA where possible. Verify every pair with an automated contrast test in `packages/ui`.

### 21.5 Layout, shape and motion

- **Grid:** 4 px base unit; spacing scale 4, 8, 12, 16, 24, 32, 48, 64.
- **Shape:** two radii only. 4 px for inputs and small controls, 12 px for sheets and the Trial Card. Most structure comes from ruled lines and whitespace, not boxes.
- **Elevation:** no drop shadows on content. A single hairline rule or a surface change separates regions. The only shadow is on sheets that slide over content.
- **Motion:** only to show what changed after an action: 150 ms ease-out for state changes, 220 ms for sheets. No entrance animations on page load. Respect `prefers-reduced-motion` (all motion off).
- **Icons:** a small custom set drawn on a 20 px grid with 1.5 px strokes, stored as inline SVG components. No icon font, no emoji, no third-party icon CDN.
- **Imagery:** none of women holding their stomachs, no stock photos, no illustrations of uteruses. If a visual is needed, it is a diagram or the woman's own data.

### 21.6 Signature component: the Trial Strip and Trial Card

The Trial Strip is a compact, ruled grid: **12 weekly columns × 4 lanes** (Benefit, Side effects, Taken, Barriers). It is the visual heart of both apps.

- **Benefit lane:** a short vertical bar per week, height = worst-pain score inverted against the baseline week, with a thin baseline rule; goal met shown as a filled dot under the bar, partly as a half dot, not met as an empty ring.
- **Side-effects lane:** a mark per week whose weight reflects "how much it bothered you" (none, a little, a lot, unbearable), using ruled marks rather than colour intensity alone.
- **Taken lane:** seven small ticks per week, filled for days taken. Readable at a glance as "mostly full" or "mostly empty".
- **Barriers lane:** a small glyph per reported barrier (cost, ran out, forgot, side effects, access), with a text legend.
- **Missing weeks:** a hatched column labelled "no entry", never blank and never zero.
- **Review marker:** a vertical rule with the review date.
- Accessible: rendered as SVG with an equivalent data table for screen readers (`<table>` visually hidden, linked by `aria-describedby`), and full keyboard navigation week by week.

The **Trial Card** wraps the strip with: treatment name and dose (Atkinson, semibold), her goal (Literata, in her words, in quotation marks), weeks elapsed, days to review, and, after review, the verdict sentence. On the woman's home screen there is one Trial Card at full width; past trials stack below as collapsed cards forming her treatment history.

### 21.7 Screens: the woman's app

1. **Welcome and enrolment.** One sentence about what this is, the clinic's name, then "Create your sign-in" (passkey). No marketing.
2. **Consent.** One purpose per screen, a plain explanation, two equal buttons ("Share with my care team" / "Don't share"). Neither pre-selected or visually favoured.
3. **Your goal.** "What would make this treatment worth it for you?" Suggested goals as large tappable rows, plus "Write my own".
4. **Home.** The current Trial Card, a single primary action ("Start this week's check-in" when due), days to review. Quick-exit button fixed in the top corner on every screen.
5. **Check-in.** One question per screen. The 0–10 pain question uses an 11-segment ruled scale, each segment a 44 px target, word anchors at 0, 5 and 10; the selected value shows in large tabular type. Progress shown as "3 of 8", not a bar. Final screen: "Saved. Your next check-in is on {date}." No celebration.
6. **Red flag.** Full-screen, `--critical` rule at the top, the instruction in the largest type in the product ("Get urgent care now"), the local emergency number as a large call button, and "I understand" to acknowledge.
7. **History.** Stacked Trial Cards; tap to expand the strip with weekly detail.
8. **Share.** Create a time-limited link or a PDF; clear statement of what the receiver will see; list of active links with "Stop sharing".
9. **Settings and privacy.** Reminders, app lock, neutral app name, consents, export, delete, access log, quick-exit explanation.

### 21.8 Screens: the clinician desk

1. **Review queue (home).** A dense list like an inbox: patient pseudonym or name (if consented and authorised), treatment, week, verdict word, due date. Red flags pinned with the `--critical` rule. Filters: due this week, overdue, by verdict. Keyboard: `J`/`K` move, `Enter` opens, `/` searches.
2. **Review.** Three regions on wide screens:
   - Left: patient context (treatment history as collapsed Trial Cards).
   - Centre: the verdict sentence in Literata ("Partly working; side effects are limiting."), the large Trial Strip, and "Why this verdict" expanding the rule trace in plain language with the numbers compared.
   - Right: decision panel with guideline options as a numbered list (`1`–`5` to select), an optional note, and "Record decision" (`Cmd/Ctrl+Enter`).
   On narrow screens and when embedded inside a record system, regions stack vertically.
3. **Start a treatment.** A single form: treatment search (coded list), dose, review interval, send enrolment link or QR.
4. **Pre-surgery check.** A ruled checklist: properly tried / not properly tried (with reason) / never tried, and fertility intentions quoted in her words. "I have discussed these with the patient" checkbox before saving.
5. **Print view.** A clean A4 summary for paper-based clinics: Trial Strip, verdict, decision, signature line.

### 21.9 Voice and copy

- Plain words, short sentences, second person for the woman. Reading age about 11 for patient screens.
- Respectful of pain: never "just", "only", "mild discomfort".
- No exclamation marks, no emoji, no cheerleading ("You've got this!").
- Uncertain states are named honestly: "Not enough check-ins yet to judge."
- Buttons say what happens: "Save check-in", not "Submit". The same action keeps the same name everywhere.
- Errors say what happened and what to do, without apologising or blaming.
- All strings in `packages/i18n`; no hard-coded text in components (lint rule).

### 21.10 Accessibility

- WCAG 2.2 AA minimum across both apps; target sizes at least 44 × 44 px on patient screens.
- Full keyboard support; visible focus ring everywhere.
- Screen-reader labels for every control; live regions for saved states and errors.
- Respects text size up to 200% without loss of content; supports `prefers-reduced-motion` and `prefers-contrast`.
- Dark mode via the same tokens.

### 21.11 Anti-patterns: do not ship any of these

- Default component-library styling (stock shadcn, Material, Bootstrap look).
- Gradient backgrounds, glassmorphism, blurred blobs, neon accents.
- Pastel pink or lavender "women's health" palettes; flowers, moons, lotus motifs.
- Rows of identical rounded cards with the same soft shadow.
- All-caps eyebrow labels above headings, "Label — fragment" headings, arrows appended to every link.
- Emoji as icons; AI sparkle icons; mascots.
- Streaks, badges, confetti, progress rings for compliance.
- Placeholder copy or lorem ipsum in any merged PR.
- A single "health score".

### 21.12 Design deliverables before UI code

1. Token file and contrast test (`packages/ui/tokens`). **Built (2026-11-10):** `packages/ui` (`@endo/ui/tokens`, `tokens.css`); every pairing passes in light, dark and more-contrast modes.
2. Trial Strip prototype with three synthetic patients (working, not taken enough, not tolerated), reviewed by a clinician and two women from the patient panel.
3. Check-in flow prototype tested for under-30-second completion.
4. Review desk prototype tested with two clinicians.

---

## 22. Build order: epics and milestones

Durations are estimates for a small team assisted by Claude Code.

| Milestone | Epics | Exit criteria |
|---|---|---|
| **M0 Foundations** (3–4 weeks) | Monorepo, CI with all security checks, Terraform dev environment, Keycloak dev realm, `packages/config`, `packages/crypto`, `packages/audit`, threat model v1, data inventory v1, ADRs 0001–0010 | A "hello" route passes through BFF, authz, audit; all CI checks green; SBOM and signed image produced |
| **M1 Identity and consent** (4 weeks) | Identity service and vault, passkey sign-in, email OTP fallback, enrolment links, consent service, quick exit, app lock | REQ-001 done; authz matrix tests for all roles; external review of auth design |
| **M2 Episodes and check-ins** (5 weeks) | Episode drafting and confirmation, goal setting, check-in instrument v1 (with `TODO_CLINICAL` placeholders), red-flag flow, offline queue, reminders | REQ-002, REQ-003, REQ-007 done; e2e offline tests pass; check-in under 30 seconds in usability test |
| **M3 Verdicts in shadow mode** (4 weeks) | Verdict engine, golden cases, rule set signing, scheduled generation, "why" trace | REQ-004 done; clinicians review shadow verdicts against their own judgement on synthetic and retrospective cases |
| **M4 Clinician desk** (5 weeks) | Review queue, review screen, decisions, pre-surgery check, print view, patient history and sharing, access log view | REQ-005, REQ-006, REQ-008 done; usability test with clinicians |
| **M5 Data rights and admin** (3 weeks) | Export, deletion with crypto-shredding, org admin, aggregate dashboard | REQ-009, REQ-010, REQ-011 done |
| **M6 Pilot readiness** (4 weeks) | Staging hardening, external penetration test, DPIA, clinical safety case, runbooks, restore drill, first record-system connector for the pilot site | Pen test findings closed; restore drill passed; clinical lead signs off rule set (no `TODO_CLINICAL`) |
| **M7 Integration** (ongoing) | SMART on FHIR launch, FHIR API, Inferno conformance, Implementation Guide published | Inferno passing; pilot site integration tested in their sandbox |

---

## 23. Repository conventions

- `CLAUDE.md` at the repository root summarises Sections 0 and 2 and links here.
- ADRs in `docs/adr/NNNN-title.md` (context, decision, consequences, alternatives).
- Conventional Commits with requirement IDs: `feat(checkin): offline queue (REQ-003, RISK-S02)`.
- `docs/runbooks/` for operations: deploy, rollback, key rotation, incident response, restore, access requests.
- `docs/clinical/` for rationale documents behind every rule set version.
- Code style enforced by ESLint and Prettier; security lint rules (no `eval`, no `dangerouslySetInnerHTML`, no raw SQL string concatenation, no `console.log` in services).
- Every package has a README stating its purpose, public API and owners.

---

## 24. Open questions that need a human

Add to this list rather than guessing.

1. First pilot market and site, which decides the first deployment region and record system.
2. Clinical lead and clinical advisory group members; sign-off on instrument wording, red flags, thresholds and guideline options (`TODO_CLINICAL`).
3. Licence for EHP-5 and any other validated instrument (`TODO_LICENCE`).
4. Retention periods per region (`TODO_LEGAL`).
5. Regulatory classification opinion for the first market; whether verdicts ship in v1 or only after certification.
6. Adolescent support: minimum age and consent model.
7. Recovery time and recovery point objectives agreed with the first customer.
8. Cloud provider confirmation and local hosting partners for Kenya and Rwanda.
9. Languages for the first pilot beyond English.
10. Section 3.2 "Create treatment episode: ✓ (own org, consented patient)": which consent purpose? Implemented as requiring `share_with_care_team`, the most restrictive reading (ADR-0007). **Decided by the product owner's delegation on 2026-11-10:** keep it.
11. Section 10.4 "care-team relationship": is it every clinician in the patient's organisation, or an explicit clinician–patient assignment? Implemented as same-organisation membership, as the matrix states (ADR-0007). **Decided by the product owner's delegation on 2026-11-10:** keep it for M1; revisit if a pilot site needs explicit assignment.
12. GitHub team handles for CODEOWNERS (security, clinical, platform, engineering). **Decided by the product owner's delegation on 2026-11-10:** until a team exists, every path is owned by `@MbuviM`, the one active maintainer. Clinical sign-off of `clinical/` files still needs a named clinician (spec 0 rule 5), and spec 12.4's second approval needs a second person.
13. Confirm the licence review of `lightningcss` (MPL-2.0, dev-only test tooling, never shipped) recorded in ADR-0010. **Decided by the product owner's delegation on 2026-11-10:** accepted: file-level copyleft in a tool we never ship or modify.
14. Commit signing method for the team and for AI-assisted commits (SSH, GPG or Sigstore gitsign), so that the signed-commits branch rule (12.4) can be enabled. **Decided by the product owner's delegation on 2026-11-10:** **SSH signing**: free, verified by GitHub, no extra tools, and the same key signs commits made with AI assistance on that person's machine. Each person adds an SSH signing key to their GitHub account. Branch rules are unavailable on GitHub Free private repositories (RISK-T04), so signatures would be visible but not enforced. **Deferred (product owner, 2026-11-10):** with one committer and no enforcement the benefit is small now; set up when a second contributor joins or before the pilot, whichever comes first.
15. Section 17.3 names HashiCorp Vault and MinIO. Vault is now under the Business Source Licence and MinIO is AGPL without free community builds; both fall outside the 18.2 licence allowlist. ADR-0014 uses OpenBao (MPL-2.0, Vault-compatible) and defers object storage (SeaweedFS candidate, Apache-2.0). **Decided by the product owner's delegation on 2026-11-10:** confirmed.
16. Zero-budget hosting: **decided by the product owner on 2026-11-10: no Oracle; an open-source, self-hosted option** (ADR-0023). **Deferred (2026-11-10):** the product owner builds alone, and the `local` environment on the development machine covers solo work, including passkey tests from a phone on the same network. `shared-dev` is built when a second person joins or testing needs an always-on environment; then: which machine (x86-64, 16 GB RAM or more, SSD, always on) and who looks after it.
17. Section 10.1 email one-time code fallback: implement as a Keycloak extension (new dependency or our own Java code in the identity stack) or as a flow in the identity service that then issues the passkey enrolment? ADR-0015 ships passkey-only sign-in until this is decided. **Proposed in ADR-0017:** the identity service issues and verifies codes; a narrow Keycloak extension (accepted by the product owner on 2026-11-08 for first-passkey enrolment) signs the patient in. **Decided by the product owner's delegation on 2026-11-10:** confirmed: the identity service issues and verifies email codes. Still open: how email is sent at zero budget without a third-party processor of identity data (spec 2.1); decided when the fallback is built. **Decided in ADR-0026 (accepted by the product owner, 2026-11-11):** Keycloak's built-in SMTP sender to a self-hosted mail server in the region (Postfix; Mailpit in dev); her email is added and confirmed in settings, and codes go only to a confirmed address.
18. REQ-001 enrolment: the product owner chose in-person clinic confirmation (ADR-0017), so remote enrolment is not supported in M1. Confirm, or specify a remote route (for example a separately delivered activation code). **Decided by the product owner's delegation on 2026-11-10:** confirmed: in-clinic only for M1.
19. Section 9.1 says idempotent replays return the original response, but the enrolment link token is meant to be shown once and stored only as a hash. Options: (a) keep an encrypted copy of the response for a short time (e.g. 24 h) so a lost response can be replayed; (b) a replay returns the invitation id and expiry without the token, and the clinic revokes and reissues. **Decided by the product owner on 2026-11-08: option (a)**, implemented with a fresh data key per stored response and a 24-hour lifetime.
20. ADR-0021 section 3 wrong-code counter: wrong entries are counted per invitation and the fifth locks it for 15 minutes. Does the count ever go back to zero other than by that lock (for example after a successful confirmation, or after some quiet period)? **Decided by the product owner's delegation on 2026-11-10:** only the lock resets it, the strictest reading, so up to four earlier wrong entries still count after a successful confirmation that was later cancelled or released.
21. ADR-0021 section 3: "Start repeated from the same browser binding returns the same transaction, not a new code". The service stores only the code's MAC, so it cannot show the code again. **Decided by the product owner's delegation on 2026-11-10:** the repeat returns the transaction without a code; her page keeps the code only in the tab's session storage, and if it is lost she cancels and starts again. (Not chosen: keeping the code encrypted under `kms/identity` until confirmation.)
22. REQ-001 returning-patient sign-in: one person can have more than one patient record (enrolled at two organisations). Which record does a sign-in open, or does she choose? **Decided by the product owner's delegation on 2026-11-11:** sign-in works only when she has exactly one patient record; with none or several it is refused, the same way as an unknown subject. Choosing between organisations comes when a second-organisation enrolment is supported.
23. REQ-002 "only one active episode per treatment line": the data model has no treatment-line field. **Decided by the product owner's delegation on 2026-11-15:** a line is a chain of episodes linked by `previous_episode_id`; a "switch" decision continues the line, an "add" starts a parallel one; an episode in review still occupies its line (clinical migration 0008). Clinical lead to confirm.
24. REQ-003 week windows. **Decided by the product owner's delegation on 2026-11-15 (engineering default, clinical lead to confirm):** weeks are her calendar days in the time zone recorded when she confirms the episode; week *k* covers days `[start + 7(k−1), start + 7k)`; its check-in opens on the week's last day, is late after the following day, and can be completed until 7 days after the week ends; after that the week stays missing. The server's receipt time decides, not the device clock, so a check-in completed offline and synced after the window is refused; its red flags are still recorded (they have their own submission and no window).
25. REQ-003 validity and baseline: what makes a check-in "valid" for the verdict's count (spec 7.2), and where is the pre-treatment baseline collected (a week-0 check-in at confirmation, or the first week)? `TODO_CLINICAL`.
26. Spec 7.2 benefit: how exactly are Q1, Q2 and Q3 aggregated, normalised, weighted and compared between the baseline and recent windows (including a baseline of zero, minimum coverage per window, overlap, and missing or "didn't apply" answers)? The engine leaves this step unimplemented until defined. `TODO_CLINICAL`.
27. Spec 7.2 other definitions: adherence for devices and injections (no day count), "patient-reported stop due to side effects" (no such question in 6.1), intolerance counting, and each modifier (`SIDE_EFFECTS_LIMITING`, `BARRIER_COST`, `BARRIER_STOCKOUT`, `DATA_GAPS`). `TODO_CLINICAL`.
28. Spec 15 reminder links "short-lived, single-purpose, opaque token": a Web Push with no payload cannot carry a token. **Decided by the product owner's delegation on 2026-11-15:** v1 push reminders carry no payload; the service worker shows the fixed generic text and opens the app's check-in page, which needs sign-in. Email and SMS reminders, when added, follow the same rule (a fixed link, no token) unless a token is later required.
29. Spec 14 offline queue key lifetime: the AES-GCM key is non-extractable and kept in IndexedDB for the life of her session (so a reload does not strand queued check-ins), and destroyed with the queue on sign-out, quick exit or session change. Confirm this retention is acceptable. **Decided by the product owner's delegation on 2026-11-15:** accepted for v1.
