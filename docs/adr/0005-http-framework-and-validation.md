# ADR-0005: Fastify for HTTP, Zod for validation

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 8.3, 9.1, 12.3; RISK-D01

## Context

Spec 8.3 names Fastify (schema-first, small) and Zod at every boundary.

## Decision

- **Fastify 5** for all HTTP services. Every instance: `bodyLimit` 100 KB (spec 12.3), `trustProxy: false` (set per deployment behind the load balancer), request logging off (our own allowlisted log line instead), case-sensitive routes.
- **Zod 4** validates configuration, service-token claims, audit events and upstream responses. Route request/response schemas currently use JSON Schema directly in Fastify; generating them from Zod with OpenAPI 3.1 output (spec 9.1) arrives with the first domain routes in M1 and will need its own ADR if a library is added.
- Unknown fields are rejected (`z.strictObject`, `additionalProperties: false`).

## Consequences

- Fastify bundles pino for logging; ADR-0006 routes all logs through an allowlist filter.

## Alternatives considered

- Express: older, not schema-first, slower. Rejected.
- Hono: good, but less mature server-side ecosystem for our needs (pino, light-my-request testing). Rejected for now.
- Valibot instead of Zod: smaller, less familiar to most reviewers. Rejected.

## Dependencies

| Package   | Why                 | Alternatives      | Maintainer health                           | Licence | Supply-chain risk                                                                                        |
| --------- | ------------------- | ----------------- | ------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `fastify` | HTTP server         | Express, Hono     | OpenJS Foundation project; active core team | MIT     | Runtime. ~15 direct deps, all within the Fastify org or pino; all MIT. Review the tree on major upgrades |
| `zod`     | Boundary validation | Valibot, ajv only | Widely used, active maintainer and sponsors | MIT     | Runtime, zero deps                                                                                       |
