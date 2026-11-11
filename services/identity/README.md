# @endo/identity

**Purpose:** the identity vault service (spec 5.2, 8.2). It is the only component that touches the identity database, which holds names, emails and phones, each encrypted under the person's own key. Internal only: callers are other services with workload tokens (ADR-0018), never browsers.

**Owners:** security engineering. Named human reviewer required.

## Public API (HTTP, internal)

| Route                                    | Access                                                  | Purpose                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                           | public (liveness)                                       | Liveness                                                                                                                                                        |
| `POST /internal/v1/persons`              | workload scope `identity.person.create` (API)           | Create a person; email and name encrypted under her own key                                                                                                     |
| `POST /internal/v1/persons/{id}/erasure` | workload scope `identity.person.erase` (jobs)           | REQ-009: mark erasure and crypto-shred her key; idempotent                                                                                                      |
| `POST /internal/v1/subjects/resolve`     | workload scope `identity.subject.resolve` (bff-clinic)  | ADR-0019: the person for a clinician's sign-in subject                                                                                                          |
| `POST /internal/v1/patients/resolve`     | workload scope `identity.patient.resolve` (bff-patient) | REQ-001: a returning patient's person, patient record and organisation for her sign-in subject; exactly one record, otherwise refused (spec Section 24 item 22) |

## Enrolment coordinator (ADR-0021, in progress)

The identity service coordinates patient enrolment. Built so far:

- `src/enrolment/state-machine.ts`: the pure transaction state machine (ADR-0021 section 10), including per-state deadlines capped by a 60-minute absolute deadline, the cancellable `claiming` step, and forward-only activation.
- `src/enrolment/code.ts`: the 6-digit confirmation code (section 3). It is drawn with a secure generator, distinct from the invitation's other pending codes, and verified in constant time by an HMAC under its own `kms/identity` data key, bound to the invitation and transaction.

- `src/enrolment/store.ts`: `PostgresEnrolmentStore` (identity migration 0003). Every change is decided by the state machine under a row lock and written with its audit event in one transaction. The database also refuses transitions outside the section 10 table, changes to a final transaction or its identity, and rewrites of decisions or claim ids.

- `confirmByCode` and identity migration 0004: the clinician's code check, with wrong codes counted per invitation and a 15-minute lock at the fifth, enforced in the database.
- `src/enrolment/routes.ts`: the patient routes, for the patient BFF only (workload scope `identity.enrolment.patient`). They exist only with the identity database and the API connection configured:

  | Route                                                  | Purpose                                                                                                                                                |
  | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `POST /internal/v1/enrolment/transactions`             | Start: link token hash and browser binding hash. Returns the code once (201); the same browser starting again gets the same transaction, no code (200) |
  | `POST /internal/v1/enrolment/transactions/{id}/status` | Her transaction's state, for the same browser binding only; any other binding is answered as not found                                                 |
  | `POST /internal/v1/enrolment/transactions/{id}/cancel` | She cancels (before her consent is claimed)                                                                                                            |

- `src/enrolment/clinical.ts`: the API client for invitation lookups (scope `api.enrolment.coordinate`).
- The identity audit outbox is relayed to the audit store every 5 seconds (`IDENTITY_AUDIT_RELAY_DATABASE_URL`, required with the database).

- `src/enrolment/activation.ts`: activation (section 10), from `claiming` to `active` one durable step at a time, run on consent and swept every 30 seconds.
- `src/enrolment/keycloak.ts`: the client for the extension's admin endpoint (scope `keycloak.enrolment.admin`; `IDENTITY_KEYCLOAK_REALM_URL`). Without it activation waits before the last step and the account stays quarantined.

- `src/enrolment/cleanup.ts`: deadlines, cancellations and cleanup (sections 10 and 11), swept every 30 seconds. An overdue pre-claim transaction is cancelled. A cancel during `claiming` is settled by releasing the reservation: either the claim already won and activation goes on, or the transaction is cancelled. In `cancelling` it deletes the provisional Keycloak user, revokes the invitation if she declined, and releases it (fenced), then marks it `cancelled`. Each step is idempotent and retried; the sweep reports only how many are still waiting.

Not yet: an alert when a transaction stays in `activating` or `cancelling` too long, and a second delete for a provisional user that Keycloak creates after cleanup has run (the quarantine guard already refuses such a user).

## Rules

- Every route declares `config.access`; the service will not start otherwise. Every authenticated request is audited before the handler runs, and an audit failure fails the request.
- Unknown request fields are rejected, never silently dropped (spec 12.3).
- Each calling service has its own key and a fixed set of scopes: the API may create people, only the jobs service may erase them.
- Staging and production need the vault database, the audit database and a real KeyManager (OpenBao); the service refuses to start without them.
