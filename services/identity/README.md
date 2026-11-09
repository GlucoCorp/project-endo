# @endo/identity

**Purpose:** the identity vault service (spec 5.2, 8.2). It is the only component that touches the identity database, which holds names, emails and phones, each encrypted under the person's own key. Internal only: callers are other services with workload tokens (ADR-0018), never browsers.

**Owners:** security engineering. Named human reviewer required.

## Public API (HTTP, internal)

| Route                                    | Access                                        | Purpose                                                     |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `GET /healthz`                           | public (liveness)                             | Liveness                                                    |
| `POST /internal/v1/persons`              | workload scope `identity.person.create` (API) | Create a person; email and name encrypted under her own key |
| `POST /internal/v1/persons/{id}/erasure` | workload scope `identity.person.erase` (jobs) | REQ-009: mark erasure and crypto-shred her key; idempotent  |

## Rules

- Every route declares `config.access`; the service will not start otherwise. Every authenticated request is audited before the handler runs, and an audit failure fails the request.
- Unknown request fields are rejected, never silently dropped (spec 12.3).
- Each calling service has its own key and a fixed set of scopes: the API may create people, only the jobs service may erase them.
- Staging and production need the vault database, the audit database and a real KeyManager (OpenBao); the service refuses to start without them.
