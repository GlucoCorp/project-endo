# ADR-0033: Durable browser sessions in Postgres

- **Status:** accepted (decided under the product owner's delegation, 2026-11-16)
- **Requirements:** spec 10.1, 10.2; ADR-0019 section 5, ADR-0021 section 12; RISK-S02

## Context

Both BFFs kept sessions in memory and refused staging and production. A restart signed everyone out, and two replicas could not share sessions. The rules are strict: patients 30 minutes idle and 12 hours absolute (60 minutes for consent-pending), clinicians 15 minutes idle and 12 hours absolute, rotation on activation, background polling that never extends a session, back-channel logout, and app lock.

## Decision

1. A new package, `@endo/session-store`, with one table, `browser_session`, in a separate `sessions` database (on the identity instance in the shared profile; the local profile keeps one instance). Each BFF has its own login role in `endo_sessions_app`; no other service can reach it.
2. Only the SHA-256 of the session token is stored. A copy of the table cannot be used to take over a session.
3. Expiry is evaluated by the database on every read (`last_seen_at` and `created_at` against the row's own limits), so every replica agrees. Reads can leave the idle clock alone (background polling).
4. Rotation (activation, consent to patient) deletes the old row and inserts the new one in one transaction; a declined rotation rolls back and leaves the old session as it was.
5. Back-channel logout deletes by Keycloak issuer and session id or subject. A sweep removes expired rows every 10 minutes.
6. Each BFF wraps the table in an adapter with the same interface and rules as its in-memory store (`PostgresPatientSessions`, `PostgresClinicSessions`), used when `BFF_*_SESSION_DATABASE_URL` is set. Postgres was chosen over Redis: it is already run, backed up and monitored, and adds no dependency.

## Consequences

- Every authenticated request reads the sessions database; its availability is the portals' availability.
- The clinic row keeps the Keycloak ID token (for logout) and the sealed refresh token; the database is reached only by the BFFs and encrypted at rest with the volume. The inventory rates the document S2.
