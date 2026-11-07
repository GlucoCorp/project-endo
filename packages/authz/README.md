# @endo/authz

**Purpose:** pure authorisation policies, `can(subject, action, resource, context) -> Allow | Deny(reason)` (spec 10.4). Encodes the spec 3.2 permission matrix.

**Owners:** security engineering (CODEOWNERS). Named human reviewer required (spec 12.11). 90% coverage on changed lines.

## Public API

| Export                                                                           | What it does                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `can(subject, action, resource, context)`                                        | Returns `{allow: true}` or `{allow: false, reason}`; deny by default |
| `ACTIONS`, `Action`, `isAction`                                                  | One action per row of the spec 3.2 matrix                            |
| `CONSENT_PURPOSES`, `ConsentPurpose`                                             | Spec 13.1 purposes                                                   |
| `Subject`, `Resource`, `AuthzContext`, `SupportTicket`, `Decision`, `DenyReason` | Types                                                                |

## Rules

- Pure: no I/O, no clock. Callers load consent state and pass `now`.
- `src/matrix.test.ts` is the spec 3.2 table cell for cell. Changing the matrix requires a spec change first.
- Postgres row-level security (`app.org_id`) is the second layer (spec 10.4) and arrives with the first tables (M1).
- Interpretations awaiting confirmation are listed in spec Section 24 (items 10 and 11).
