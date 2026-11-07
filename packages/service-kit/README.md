# @endo/service-kit

**Purpose:** shared hardening for every Fastify service (ADR-0006): service tokens, the log allowlist, RFC 9457 problem details, security headers, route-policy enforcement and request IDs.

**Owners:** security engineering (CODEOWNERS). Named human reviewer required (spec 12.11).

## Public API

| Export                                                                             | What it does                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ServiceTokenSigner`, `ServiceTokenVerifier`                                       | Ed25519, 60-second, audience-restricted service tokens carrying the end-user subject (spec 8.4)  |
| `generateServiceKeyPair()`                                                         | Dev/test key pairs only; deployed keys come from the secrets manager                             |
| `loggerOptions(service, level, stream?)`, `filterLogFields`, `LOG_FIELD_ALLOWLIST` | Spec 20 allowlist logging: unknown fields dropped; URLs, headers and error messages never logged |
| `registerProblemHandlers(app)`, `ProblemError`, `problemBody`                      | RFC 9457 errors that never echo input (spec 9.1)                                                 |
| `API_SECURITY_HEADERS`, `WEB_SECURITY_HEADERS`                                     | Spec 12.2 headers                                                                                |
| `enforceRouteDeclarations(app, key, isValid)`                                      | Startup fails if any route lacks a policy declaration (spec 2.5)                                 |
| `requestIdFrom(header, trust)`                                                     | UUID request IDs; external values ignored                                                        |
