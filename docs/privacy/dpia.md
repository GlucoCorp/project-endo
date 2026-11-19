# Data protection impact assessment (draft)

**Status:** draft prepared from the build for the DPO (spec 22, M6). Sections marked `TODO_LEGAL` need the DPO's assessment and sign-off before the pilot. Nothing here is legal advice.

## 1. The processing

Project Endo lets a woman with endometriosis, adenomyosis or fibroids track a prescribed treatment week by week, so that she and her clinician can judge, at a planned review, whether it is working. Clinicians review the record and decide (continue, switch, add, refer, stop), and can check before surgery which treatments were properly tried.

| Item             | Detail                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller       | The clinic (organisation) that enrols her (`TODO_LEGAL`: confirm per contract)                                                                                                                               |
| Processor        | GluCorp (operates the service)                                                                                                                                                                               |
| People           | Patients (adults), clinicians, organisation admins                                                                                                                                                           |
| Data             | Identity (name, email; identity vault); health data (treatments, goals, weekly answers, red-flag reports, decisions, pre-surgery checks); consent decisions; access log. Full list: `docs/data-inventory.md` |
| Special category | Health data (GDPR art. 9; Kenya DPA s. 44 "sensitive personal data"); reproductive health (heightened risk, RISK-I04)                                                                                        |
| Sources          | The patient and her clinicians; no third-party data sources                                                                                                                                                  |
| Recipients       | Her care team (with `share_with_care_team`); people she gives a share link to; no advertisers, no analytics vendors (spec 2)                                                                                 |
| Regions          | Data stays in the deployment region (spec 2: no PHI leaves the region)                                                                                                                                       |
| Retention        | `docs/data-inventory.md` per column; clinical record period `TODO_LEGAL`; audit 7 years; exports none kept; deletion after 14 days on request                                                                |

## 2. Lawful basis and necessity

- Basis for processing health data: `TODO_LEGAL` (explicit consent at enrolment for self-tracking and care-team sharing; provision of health care by the clinic as controller).
- Separate, optional purposes are asked for separately and can be withdrawn at any time, with effect on the next request (spec 13.1): `share_with_care_team`, `org_aggregate_reporting`, research purposes (not enabled).
- Data minimisation: identity and clinical data are in separate databases with separate keys; the clinical side holds opaque ids only; reminders carry no health content; share links show no identity or clinic; the dashboard shows counts with small-cell suppression.

## 3. Her rights

| Right                   | How                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Information             | Consent screens with versioned explanations; privacy notice (`TODO_LEGAL`)                          |
| Access                  | History and access log in the app; full export as a FHIR Bundle (REQ-009)                           |
| Rectification           | Correction requests through the DPO contact route (spec 13.4)                                       |
| Erasure                 | In the app: 14 days to change her mind, then hard deletion and crypto-shredding (REQ-009, ADR-0029) |
| Restriction / objection | Withdraw `share_with_care_team` or `org_aggregate_reporting` at any time                            |
| Portability             | FHIR export                                                                                         |

## 4. Risks and measures

| Risk                                               | Likelihood / severity | Measures in the build                                                                                                         | Residual                                                                                           |
| -------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Someone on a shared phone sees her data (RISK-S02) | `TODO_LEGAL`          | 30 min idle, 12 h absolute sessions; app lock; quick exit; neutral app name; recent sign-in for export, deletion, share links | Shoulder-surfing while unlocked                                                                    |
| Breach of the clinical database (RISK-I01)         |                       | Per-patient keys; identity elsewhere; row-level security per organisation; no PHI in logs (tested with a marker)              | Ciphertext and pseudonymous rows exposed                                                           |
| Cross-organisation access (RISK-I03)               |                       | Authorisation matrix tests; RLS as second layer; organisation from the session, never the browser                             |                                                                                                    |
| Legal demand for reproductive data (RISK-I04)      |                       | Data held in-region; minimal data; deletion on request; transparency report (`TODO_LEGAL`)                                    | Depends on jurisdiction                                                                            |
| Share link forwarded (RISK-I07)                    |                       | Hash only, at most 30 days, revocable, every view in her access log, no identity                                              | Recipient may copy what they saw                                                                   |
| Re-identification from the dashboard               |                       | Consented patients only; minimum cell 10 with complementary suppression; consent as at each event; completed months only      | Differencing across an erasure (Section 24 item 40)                                                |
| Erased data survives (RISK-I06, RISK-I08)          |                       | Key destroyed first; rows deleted; identity purged; restores replay erasures                                                  | Keycloak account removed by operator (item 38); backups until expiry (encrypted fields unreadable) |
| Staff misuse                                       |                       | Phishing-resistant MFA; no standing access; just-in-time elevation; every health-data access audited and visible to her       |                                                                                                    |

## 5. Consultation and sign-off

- Patient representatives: `TODO_LEGAL` (usability sessions planned with the clinical lead).
- DPO opinion: `TODO_LEGAL`.
- Prior consultation with the supervisory authority needed: `TODO_LEGAL`.
- Review: before the pilot, then yearly or on any change to purposes, data or recipients.
