# @endo/integration

**Purpose:** the integration service (spec 8.2, 9.3, 16; ADR-0030): a read-only FHIR R4 facade for record systems, authenticated with SMART Backend Services. It holds no data: every read goes to the API with this service's workload key, and the API checks the organisation, her `share_with_care_team` consent and the client's kill switch, and audits the read against her record.

**Owners:** platform engineering with security engineering. Named human reviewer required (it authenticates external clients).

## Public API (HTTP)

| Route                                               | Access                      | Purpose                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /healthz`                                      | public (liveness)           | Liveness                                                                                                                                                                             |
| `GET /.well-known/smart-configuration`              | public (discovery)          | Token endpoint, `private_key_jwt` with ES384 or RS384, `system/*.rs` scopes                                                                                                          |
| `GET /fhir/r4/metadata`                             | public (discovery)          | CapabilityStatement                                                                                                                                                                  |
| `POST /oauth/token`                                 | public (token)              | `client_credentials` with a signed client assertion (iss = sub = client_id, aud = this endpoint, at most 5 minutes, jti used once); an opaque 5-minute token with the granted scopes |
| `GET /fhir/r4/Patient/{id}`                         | bearer, `system/Patient.rs` | Her pseudonymous Patient resource                                                                                                                                                    |
| `GET /fhir/r4/{Type}?patient={id}` (`Patient?_id=`) | bearer, `system/{Type}.rs`  | Search by patient only: CarePlan, Goal, QuestionnaireResponse, Consent; Observation answers an empty set while verdicts run in shadow mode                                           |

Errors under `/fhir/` are `OperationOutcome` resources.

## Configuration

`INTEGRATION_PORT`, `INTEGRATION_HOST`, `INTEGRATION_BASE_URL` (public base), `INTEGRATION_API_BASE_URL`, `INTEGRATION_WORKLOAD_PRIVATE_KEY_JWK` (the API trusts it as `integration` for `api.integration.resolve` and `api.fhir.read` only: `API_INTEGRATION_WORKLOAD_PUBLIC_KEY_JWK`), `INTEGRATION_RATE_LIMIT_PER_MINUTE`.

## Clients

An organisation admin registers a client in the API (`POST /v1/org/integrations`: name, public JWK Set, scopes) and gets its `client_id`; `POST /v1/org/integrations/{id}/active` is the kill switch, effective on the client's next request.
