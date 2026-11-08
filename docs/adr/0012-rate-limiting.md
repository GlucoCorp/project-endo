# ADR-0012: Rate limiting with @fastify/rate-limit

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 12.3; RISK-D01

## Context

Spec 12.3 requires rate limits per IP, per session, per account and per endpoint class, with stricter limits and exponential lockout on authentication endpoints. CodeQL (`js/missing-rate-limiting`) correctly flagged that the API's authorisation path had none.

## Decision

- Use **@fastify/rate-limit** as an **app-level `onRequest` hook** (`app.rateLimit(...)`, plugin registered with `global: false`), added after the security-headers hook and before the authentication hook. Do **not** switch to the plugin's `global: true` mode: it attaches per-route hooks, which Fastify runs _after_ app-level hooks, so authentication would run before the limiter (a test covers this ordering).
- Security headers are set in an `onRequest` hook registered before the limiter, so throttled responses still carry them.
- A 429 is an RFC 9457 problem (`rate_limited`) with generic text: no key, IP or limit in the body. The plugin sets `retry-after` and the `x-ratelimit-*` headers.
- Liveness routes (`/healthz`) are exempt so load-balancer probes are never throttled.
- Defaults are configurable via environment variables:
  - `bff-patient`: 120 requests/minute per client IP (`BFF_PATIENT_RATE_LIMIT_PER_MINUTE`).
  - `api`: 1200 requests/minute per caller (`API_RATE_LIMIT_PER_MINUTE`). Its callers are BFFs and jobs, so this is a backstop.

  These are engineering defaults, not product or clinical values. Tune them with the k6 load tests (spec 19.9: 10,000 check-ins/hour/region).

## Consequences and follow-ups

- **In-memory per instance.** With N instances, the effective limit is N times the configured value. A shared store (Postgres or Redis) comes with the infrastructure slice.
- **Client IP behind the load balancer.** `trustProxy` must be set per deployment so `req.ip` is the client, not the load balancer. This goes in the infrastructure slice and its runbook.
- **Clinic NAT.** Many patients at one clinic may share an IP. Per-session and per-account limits, plus stricter sign-in limits with exponential lockout, arrive with real sessions in M1.
- WAF rules at the edge (spec 12.6) remain the first line of defence.

## Alternatives considered

- Hand-written limiter: small, but not recognised by CodeQL and easy to get subtly wrong (window edges, header semantics). Rejected.
- Edge-only limiting (WAF): needed, but cannot key by session or account. Kept as an additional layer.

## Dependencies

| Package                      | Why                   | Alternatives           | Maintainer health        | Licence | Supply-chain risk                                                                                                         |
| ---------------------------- | --------------------- | ---------------------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@fastify/rate-limit@11.2.1` | Spec 12.3 rate limits | hand-written; WAF only | Fastify core org, active | MIT     | Runtime. Deps: `fastify-plugin`, `toad-cache` (already present via Fastify), `@lukeed/ms`, `ip-address` (both MIT, small) |
