// Code systems used by Project Endo resources (services/api/src/export.ts).

CodeSystem: EndoReviewDecision
Id: review-decision
Title: "Project Endo review decision"
Description: "The decision a clinician records at a planned review (REQ-005)."
* ^url = "https://fhir.glucorp.health/CodeSystem/review-decision"
* ^status = #draft
* ^caseSensitive = true
* #continue "Continue" "Keep the same treatment for another trial period."
* #switch "Switch" "Stop this treatment and start another."
* #add "Add" "Keep this treatment and add another."
* #refer "Refer" "Refer to another service."
* #stop "Stop" "Stop the treatment."

CodeSystem: EndoConsentPurpose
Id: consent-purpose
Title: "Project Endo consent purpose"
Description: "Purposes she decides separately (spec 13.1)."
* ^url = "https://fhir.glucorp.health/CodeSystem/consent-purpose"
* ^status = #draft
* ^caseSensitive = true
* #self_tracking "Self-tracking" "Her own tracking of the treatment."
* #share_with_care_team "Share with care team" "Her clinicians see her record."
* #org_aggregate_reporting "Aggregate reporting" "Counted in de-identified organisation figures."

CodeSystem: EndoRecordType
Id: record-type
Title: "Project Endo record type"
Description: "Record types carried as Basic resources."
* ^url = "https://fhir.glucorp.health/CodeSystem/record-type"
* ^status = #draft
* ^caseSensitive = true
* #pre-surgery-check "Pre-surgery check" "What the clinician reviewed with her before considering surgery (REQ-006)."

CodeSystem: EndoTag
Id: tag
Title: "Project Endo tag"
Description: "Resource tags."
* ^url = "https://fhir.glucorp.health/CodeSystem/tag"
* ^status = #draft
* ^caseSensitive = true
* #pseudonymous "Pseudonymous" "The resource carries no direct identifier."

// Red-flag codes and the verdict code system come from signed clinical content (clinical/,
// packages/verdict) and are added when the clinical lead signs them off: TODO_CLINICAL.
