# @endo/identity

**Purpose:** the identity vault service (spec 5.2, 8.2). It is the only component that touches the identity database, which holds names, emails and phones, each encrypted under the person's own key. Internal only: callers are other services with workload tokens (ADR-0018), never browsers.

**Owners:** security engineering. Named human reviewer required.

## Public API (HTTP, internal)

| Route                                    | Access                                        | Purpose                                                     |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `GET /healthz`                           | public (liveness)                             | Liveness                                                    |
| `POST /internal/v1/persons`              | workload scope `identity.person.create` (API) | Create a person; email and name encrypted under her own key |
| `POST /internal/v1/persons/{id}/erasure` | workload scope `identity.person.erase` (jobs) | REQ-009: mark erasure and crypto-shred her key; idempotent  |

## Enrolment coordinator (ADR-0021, in progress)

The identity service coordinates patient enrolment. Built so far:

- `src/enrolment/state-machine.ts`: the pure transaction state machine (ADR-0021 section 10), including per-state deadlines capped by a 60-minute absolute deadline, the cancellable `claiming` step, and forward-only activation.
- `src/enrolment/code.ts`: the 6-digit confirmation code (section 3). It is drawn with a secure generator, distinct from the invitation's other pending codes, and verified in constant time by an HMAC under its own `kms/identity` data key, bound to the invitation and transaction.

- `src/enrolment/store.ts`: `PostgresEnrolmentStore` (identity migration 0003). Every change is decided by the state machine under a row lock and written with its audit event in one transaction. The database also refuses transitions outside the section 10 table, changes to a final transaction or its identity, and rewrites of decisions or claim ids.

The code check and wrong-code limits, routes and the deadline sweep come in later slices.

## Rules

- Every route declares `config.access`; the service will not start otherwise. Every authenticated request is audited before the handler runs, and an audit failure fails the request.
- Unknown request fields are rejected, never silently dropped (spec 12.3).
- Each calling service has its own key and a fixed set of scopes: the API may create people, only the jobs service may erase them.
- Staging and production need the vault database, the audit database and a real KeyManager (OpenBao); the service refuses to start without them.
