// Profiles for the resources Project Endo serves (spec 5.3, 9.3).

Profile: EndoPatient
Parent: Patient
Id: endo-patient
Title: "Project Endo Patient (pseudonymous)"
Description: "A pseudonymous patient: no name, contact, address, birth date or identifier (spec 5.3)."
* meta.tag 1..*
* identifier 0..0
* name 0..0
* telecom 0..0
* address 0..0
* birthDate 0..0
* photo 0..0
* contact 0..0

Profile: EndoCarePlan
Parent: CarePlan
Id: endo-careplan
Title: "Project Endo treatment trial"
Description: "One treatment trial: the treatment, dose, start and planned review."
* intent = #plan
* subject only Reference(EndoPatient)
* period 1..1
* period.start 1..1
* period.end 1..1
* activity 1..1
* activity.detail 1..1
* activity.detail.kind = #MedicationRequest
* activity.detail.code 1..1
* activity.detail.description 1..1

Profile: EndoGoal
Parent: Goal
Id: endo-goal
Title: "Project Endo goal"
Description: "What she hopes the treatment will change."
* subject only Reference(EndoPatient)
* description.text 1..1

Profile: EndoWeeklyCheckIn
Parent: QuestionnaireResponse
Id: endo-weekly-checkin
Title: "Project Endo weekly check-in"
Description: "One weekly check-in against the versioned instrument (items are TODO_CLINICAL until signed off)."
* status = #completed
* questionnaire 1..1
* subject only Reference(EndoPatient)
* basedOn 1..1
* basedOn only Reference(EndoCarePlan)
* authored 1..1

Profile: EndoConsent
Parent: Consent
Id: endo-consent
Title: "Project Endo consent decision"
Description: "Her current decision for one purpose (spec 13.1)."
* patient only Reference(EndoPatient)
* category 1..1
* category from EndoConsentPurposes (required)
* dateTime 1..1

ValueSet: EndoConsentPurposes
Id: consent-purposes
Title: "Project Endo consent purposes"
* ^status = #draft
* include codes from system https://fhir.glucorp.health/CodeSystem/consent-purpose
