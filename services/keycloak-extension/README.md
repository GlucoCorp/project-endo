# endo-keycloak-extension

**Purpose:** the one Keycloak extension (ADR-0017, ADR-0021 sections 7, 8 and 10; ADR-0025): a patient's first passkey through an enrolment handoff from the identity coordinator. The repository's only Java code.

**Owners:** security; every change needs security review (Java sources and `pom.xml`).

## Public API (Keycloak providers)

| Provider id              | Kind            | What it does                                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endo-enrolment`         | Authenticator   | Without `endo_handoff` in the request: `attempted()`. With it: redeems the handoff with the coordinator (every bound value from Keycloak's own session), creates or resumes the provisional user with the coordinator's id and `endo_enrolment=<transaction>`, or ends the flow on a terminal error page |
| `endo-quarantine-guard`  | Authenticator   | REQUIRED after sign-in: a user still in enrolment may finish only the sign-in that redeemed that transaction                                                                                                                                                                                             |
| `endo-enrolment-passkey` | Required action | Keycloak's passwordless WebAuthn registration, only inside a bound enrolment (checked on challenge and on answer); not reachable through `kc_action`; reports the committed passkey after Keycloak's transaction commits                                                                                 |

Configuration (environment, read at start-up): `ENDO_IDENTITY_BASE_URL` and `ENDO_KEYCLOAK_WORKLOAD_PRIVATE_KEY_JWK` (Ed25519, its own workload key; scope `identity.enrolment.keycloak`). Missing or invalid configuration makes every handoff fail closed.

## Build

`docker build -t endo-keycloak:dev services/keycloak-extension` builds and tests the extension in the digest-pinned Maven container (Maven Central only, strict checksums, every plugin pinned, no snapshots or ranges) and bakes it into the pinned Keycloak 26.8.1 image. CI runs the same build.

## Not yet

Activation's finalise and provisional-user deletion endpoints (slice 6) and the real-Keycloak browser tests (slice 8).
