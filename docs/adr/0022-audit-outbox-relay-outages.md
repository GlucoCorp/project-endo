# ADR-0022: The audit outbox relay waits out outages and sets aside only bad events

- Status: accepted (product owner, 2026-11-10: stall with an alert rather than skip)
- Date: 2026-11-10
- Requirements/Risks: spec 2.6 (every health-data access audited), spec 12.9; ADR-0021 section 14; RISK-R01

## Context

The clinical and identity stores each write audit events to their own outbox, in the same database transaction as the change they describe. A shared relay (`relayAuditOutbox` in `@endo/db`) publishes them to the audit store.

Until now the relay counted **every** failed publish as an attempt and set an event aside after five. The relay runs every five seconds, so an audit-store outage of about 25 seconds used up the attempts of every waiting event. Those events then stayed in the outbox unpublished until a person intervened, and the per-run failure count stopped reporting them. An independent review of PR #30 found this.

## Decision

1. **Two kinds of failure.**
   - A publisher throws `PermanentPublishError` only when the event itself can never be published, because it fails the audit schema. Only this counts an attempt, and after five the event is set aside, as before, so one bad event cannot block the rest.
   - Any other failure (the audit store unreachable, a timeout) is an outage. Nothing is counted, and the run stops. The next run starts again from the oldest unpublished event, so an outage of any length loses nothing. Delivery stays at least once and **unordered** across relays, as before: with several service replicas, one relay can publish a later event while another holds an earlier one. Every event keeps its original time, which the audit store records, so nothing depends on delivery order.
2. **Stall rather than skip.** If the audit store keeps refusing one valid event for some other reason, delivery stalls behind it. For an audit trail, a visible stall is better than silently skipping events.
3. **Alert from counts.** `outboxHealth()` reports pending events, set-aside events and the age of the oldest pending event, by the database clock. After every run, each service writes one alert line, with counts only, while anything is set aside or the oldest pending event is older than 60 seconds (`outboxAlert`). The line repeats until a person fixes it.

## Consequences

- An audit-store outage delays audit delivery but no longer strands events. The services keep working, and events wait in their store's outbox.
- A stalled queue needs a person, and the alert says so every five seconds. Replaying set-aside events is still a manual, reviewed database operation. A controlled replay tool comes with the operations runbooks (M6).
- Log-based alerting relies on the platform's log alerting (infra slice). Until then the line appears in the service's standard error.

## Alternatives considered

- **Backoff with a next-attempt time per event.** That needs a column and trigger changes in both stores. Stopping the run at the first outage already avoids hammering a down store, at the five-second cadence.
- **Skipping a refused event after N attempts whatever the cause.** Rejected: an outage is not the event's fault, and audit events must not be lost quietly.
