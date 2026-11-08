# ADR-0006: BFF pattern, service tokens and `packages/service-kit`

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 2.3, 2.5, 8.4, 9.1, 12.2, 20; RISK-S01, RISK-I02, RISK-E01

## Context

Spec 8.4: browsers never hold access tokens; a BFF keeps tokens server-side behind a `__Host-` `HttpOnly` `Secure` `SameSite=Strict` cookie. Service-to-service calls use mutual TLS **and** short-lived signed service tokens with audience restriction.

Several hardening pieces are needed by every service: token signing/verification, log allowlisting, problem details, security headers, route-policy enforcement.

## Decision

### Service tokens

- JWT signed with **Ed25519 (`EdDSA`)**, `typ: endo-service+jwt`, lifetime **60 s**, clock tolerance 5 s.
- Claims: `iss` (calling service), `aud` (target service), `sub`, `role`, `org_id`, `patient_id`, `iat`, `exp`, `jti`.
- The verifier pins the algorithm, audience, `typ` and an **issuer allowlist** per target. Claims are re-validated with Zod.
- Private keys live only in the calling service (secrets manager in deployed environments; `tools/dev-keys.mjs` locally). The API holds only public keys.
- mTLS is added by the infrastructure slice; tokens are not a substitute for it.

### `packages/service-kit` (new, not in spec 8.2)

Holds the shared hardening so it is written and reviewed once: `ServiceTokenSigner/Verifier`, `loggerOptions` + `filterLogFields` (allowlist), `registerProblemHandlers` (RFC 9457, never echoes input), `API_SECURITY_HEADERS` / `WEB_SECURITY_HEADERS` (spec 12.2), `enforceRouteDeclarations` (startup fails on a route without a policy), `requestIdFrom`.

### Route policies

- API routes declare `config.policy` (`public` with an enumerated reason, or `protected` with an authz action, purpose and resource builder). BFF routes declare `config.auth`.
- A route without a valid declaration throws at registration, so the service cannot start and tests fail (spec 2.5). This replaces a separate static CI scan.

## Consequences

- Dev sessions (`DevSessionStore`) exist only until Keycloak passkey sessions (M1) and refuse to construct in staging/production.
- Request IDs: the API trusts `x-request-id` from internal callers (UUID only); BFFs always generate their own.

## Alternatives considered

- Hand-rolled token format with `node:crypto` sign/verify: smaller, but token parsing and claim validation are a common source of vulnerabilities. Rejected in favour of a well-reviewed library.
- Opaque tokens with introspection: extra network hop on every call and a single point of failure. Rejected.
- `@fastify/helmet` for headers: another dependency for ~15 static headers. Rejected.
- `@fastify/cookie`: we read exactly one cookie; a 10-line reader with tests suffices. Revisit when setting cookies (M1).

## Dependencies

| Package | Why                                              | Alternatives                                   | Maintainer health                                                                           | Licence | Supply-chain risk                                                                                                                                       |
| ------- | ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jose`  | JWT/JWS signing and verification using WebCrypto | `jsonwebtoken` (Node-only, older), hand-rolled | Long-running, single principal maintainer with sponsorship; certified OpenID library author | MIT     | Runtime, **zero dependencies**. Single-maintainer risk mitigated by pinning, 7-day release age, and narrow usage behind `service-kit` (easy to replace) |
