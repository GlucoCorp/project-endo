# Project Endo Implementation Guide

Project Endo measures whether a treatment for endometriosis, adenomyosis or fibroids is working for the woman taking it, week by week until a planned review. This guide describes the read-only FHIR R4 API that record systems use (spec 9.3) and the resources in a patient's export (REQ-009).

- **Patient** is pseudonymous: no name, contact or record-system identifier. A record system maps its own patient to ours only through the explicit link made at SMART launch (spec 16.2).
- **CarePlan** is one treatment trial: the treatment, dose, start and planned review.
- **Goal** is what she hopes the treatment will change, in her words or from a template.
- **QuestionnaireResponse** is one weekly check-in.
- **Consent** is her current decision for each purpose.
- **Observation** (verdicts) is not released while verdicts run in shadow mode.

Access: SMART Backend Services (`private_key_jwt`, ES384 or RS384), `system/*.rs` scopes, search by patient only.

Clinical content (the check-in items, red flags, thresholds) is not final: items marked `TODO_CLINICAL` in the source wait for the clinical lead's sign-off.
