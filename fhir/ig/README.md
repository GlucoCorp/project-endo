# Project Endo Implementation Guide (FSH source)

**Purpose:** the Implementation Guide for Project Endo's FHIR API and export (spec 5.3, 9.3, 16.5), in FHIR Shorthand: profiles for the pseudonymous Patient, the treatment trial (CarePlan), Goal, the weekly check-in (QuestionnaireResponse) and Consent, and the project's code systems. The server's CapabilityStatement is served by `services/integration` at `/fhir/r4/metadata`.

**Owners:** platform engineering with the clinical lead (clinical code systems).

**Status:** source only. Building it with SUSHI and the HL7 IG Publisher, validating outbound resources with the HL7 validator, and running Inferno in CI are proposed in ADR-0031 and wait for approval (new dependencies, spec 0 rule 3). Red-flag and verdict code systems wait for signed clinical content (`TODO_CLINICAL`).
