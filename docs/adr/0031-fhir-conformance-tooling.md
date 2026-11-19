# ADR-0031: FHIR Implementation Guide build and conformance testing

- **Status:** proposed (needs the product owner's approval: new dependencies, spec 0 rule 3)
- **Requirements:** spec 5.3, 9.3, 16.5; M7 exit criteria (Inferno passing; IG published)

## Context

Spec 16.5 asks for Inferno conformance tests in CI on every release, and spec 5.3 for an Implementation Guide in FSH, built with SUSHI and the IG Publisher, with every outbound resource validated by the HL7 validator. None of these tools is in the repository. The FSH source is in `fhir/ig/` (M7c).

## Proposal

| Tool                                     | What for                                                                                        | Licence                | Maintainers                             | Supply-chain notes                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| SUSHI (`fsh-sushi`, npm)                 | Compile FSH to FHIR conformance resources                                                       | Apache-2.0             | HL7 FHIR Shorthand project (MITRE, HL7) | Pin an exact version; run only in a CI job, never in services       |
| HL7 IG Publisher (`publisher.jar`)       | Build the IG site; QA report                                                                    | Apache-2.0-style (HL7) | HL7 FHIR core team                      | Java; download a pinned release by checksum in CI                   |
| HL7 FHIR validator (`validator_cli.jar`) | Validate the export and API responses against the IG in CI and in non-production runtime checks | Apache-2.0             | HL7 FHIR core team                      | As above; non-production only                                       |
| Inferno (ONC test kits, Docker)          | SMART Backend Services and FHIR API conformance against staging                                 | Apache-2.0             | ONC / MITRE                             | Pinned image digest; runs against staging only, with synthetic data |

A CI workflow (`fhir-conformance.yml`) would: build the IG with SUSHI and the publisher, validate synthetic export Bundles and API responses, and on release candidates run Inferno against staging. Nothing runs against production data.

## Alternatives

- Hand-written JSON StructureDefinitions without SUSHI: harder to review, same validation gap.
- Firely Terminal / .NET validator: comparable; fewer HL7 community test kits.
- No conformance testing: rejected by spec 16.5.

## Decision

Pending the product owner's approval. Until then the FSH source and the CapabilityStatement are maintained by hand, and no new tool is added to CI.
