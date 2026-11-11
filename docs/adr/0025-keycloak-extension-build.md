# ADR-0025: Building the Keycloak enrolment extension (Java dependencies and pipeline)

- Status: accepted (product owner, 2026-11-11)
- Date: 2026-11-11
- Requirements/Risks: spec 0 rule 3, 12.4, 18.2; ADR-0017 (Java extension accepted as an exception), ADR-0021 sections 7, 8 and 15; RISK-S04, RISK-T02

## Context

ADR-0017 accepted one narrow Keycloak extension, the repository's only Java code, for a patient's first passkey. ADR-0021 section 15 set the rules for building it. The identity side of the handoff is built (#37). This ADR records the exact Java dependencies and build pipeline, as spec 0 rule 3 requires.

## Decision

### What the extension contains (ADR-0021 sections 7, 8 and 10)

- **`endo-enrolment` authenticator:** with no `endo_handoff` parameter it answers `attempted()`. With one, it redeems it with the identity coordinator, creates (or, on a retry, resumes) the provisional user with the id the coordinator chose and `endo_enrolment=<transaction>`, or ends the flow on a terminal error page.
- **`endo-enrolment-passkey` required action:** passwordless WebAuthn registration that checks the redeemed binding. It can't be reached through `kc_action`.
- **Post-commit hook:** reports the committed credential to the coordinator.
- **User-storage guard:** ordinary sign-in refuses users who still carry `endo_enrolment`.
- **Outbound calls:** the extension calls the identity service with a workload token (scope `identity.enrolment.keycloak`), signed with its own key.

### Dependencies

| Coordinates                                | Version | Scope    | Licence    | Why                                                      |
| ------------------------------------------ | ------- | -------- | ---------- | -------------------------------------------------------- |
| `org.keycloak:keycloak-server-spi`         | 26.8.1  | provided | Apache-2.0 | Authenticator and required-action interfaces             |
| `org.keycloak:keycloak-server-spi-private` | 26.8.1  | provided | Apache-2.0 | Authentication flow context (internal API, ADR-0021 s16) |
| `org.keycloak:keycloak-services`           | 26.8.1  | provided | Apache-2.0 | WebAuthn registration support                            |
| `org.keycloak:keycloak-core`               | 26.8.1  | provided | Apache-2.0 | Tokens and representations                               |
| `org.junit.jupiter:junit-jupiter`          | pinned  | test     | EPL-2.0    | Unit tests (dev only, never shipped; licence review)     |

- **Provided means nothing new ships.** Keycloak already contains these classes; the extension JAR has no dependencies of its own. Versions are pinned to the Keycloak image, which is itself pinned by digest (`quay.io/keycloak/keycloak:26.8.1@sha256:3f3c…`). They are upgraded together.
- **Signing the workload token:** the JDK's built-in Ed25519 (`java.security`), with no JWT library.
- **EPL-2.0 (JUnit):** like the MPL-2.0 tools in ADR-0010, a weak copyleft used only in tests and never distributed. It is recorded for licence review.

### Build pipeline (ADR-0021 section 15)

- **Container:** Maven runs in a digest-pinned build container (`maven:3.9-eclipse-temurin-21@sha256:…`), never on a developer machine.
- **Dependency rules:**
  - plugins and dependencies at exact versions, from Maven Central only;
  - `--strict-checksums`;
  - no snapshots and no version ranges;
  - the enforcer plugin refuses all three.
- **CI scanning:** OSV-Scanner on the resolved tree, Semgrep Java rules, and CodeQL for Java.
- **Image:** the JAR is baked into an `endo-keycloak` image from the pinned Keycloak base, with an SBOM, signed and verified like the other images (ADR-0016).
- **Review:** CODEOWNERS sends Java sources and the POM to security review.

## Consequences

- **Keycloak upgrades:** every one must pass the real-Keycloak test suite (ADR-0021 section 16), because the private SPI can change.
- **CI cost:** about one extra build job per change to the extension. Within the free plan.

## Alternatives considered

- **A JavaScript authenticator:** Keycloak removed script authenticators from default builds. The extension would still be Java underneath.
- **Gradle:** equally capable, but Maven's checksum and enforcer support is simpler to pin. Keycloak's own examples use Maven.
