# @endo/clinical-store

**Purpose:** the clinical database schema for organisations, clinicians, pseudonymous patient records, enrolment invitations and consent decisions (spec 4 REQ-001, 5.1, 10.4, 13.1; RISK-I01, RISK-I03). No names, emails, phones or addresses: identity lives in the identity vault and is referenced only by `identity_ref`.

**Owners:** engineering, with security review (holds consent and enrolment state). Named human reviewer required.

## Public API

| Export                               | What it does                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClinicalDatabase`                   | Kysely table types matching the migrations                                                                                                                                                                                                                   |
| `withOrg(db, orgId, fn)`             | Runs `fn` in a transaction with `app.org_id` set, which row-level security uses to isolate organisations. The setting ends with the transaction                                                                                                              |
| `findLiveInvitation(db, tokenHash)`  | The only cross-organisation lookup: finds an unclaimed, unexpired, unrevoked invitation by its token hash; also says whether it is reserved                                                                                                                  |
| `PostgresInvitationReservationStore` | Reserve, release, revoke (`revokeHeld`: only while this transaction holds it, after a decline) and claim an invitation for one enrolment transaction (ADR-0021 sections 6 and 11); each locks the row, is idempotent per transaction and audits only changes |
| `CONSENT_PURPOSES`, `ConsentPurpose` | Spec 13.1 purposes (kept identical to the database constraint by a test)                                                                                                                                                                                     |
| `CLINICAL_MIGRATIONS_DIR`            | SQL migrations; apply with `pnpm --filter @endo/clinical-store migrate` (`ENDO_CLINICAL_MIGRATION_DATABASE_URL`)                                                                                                                                             |

## Rules

- The API connects as a member of `endo_clinical_app`. It cannot delete patient records, rewrite consent history or change an invitation's token or expiry.
- Every query that touches organisation data runs inside `withOrg`. With no organisation set, row-level security returns nothing.
- Consent is append-only: one row per decision; the latest row per purpose is the current state.
- Invitations store only the SHA-256 of the link token, are valid at most 7 days, and are claimed with a conditional update so a link works once.
- Since migration 0005 a claim needs the claiming transaction's reservation, a reservation never passes directly to another transaction, and a released transaction (recorded in `enrolment_reservation_fence`) can never reserve again; the trigger enforces all three.
