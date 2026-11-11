# @endo/clinic-web

**Purpose:** the clinician desk (spec 21.8): the standalone portal, later also launched from a record system (SMART on FHIR, M7). React, Vite and TanStack Router (ADR-0024), `@endo/ui` tokens, all text from `@endo/i18n`.

**Owners:** clinician experience team; security-relevant changes (sessions, CSRF, enrolment) need security review.

## Public API (screens)

| Path               | Screen                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`, `/enrolments` | Sign in (through the clinic BFF, ADR-0019), choose the organisation, then confirm a patient: select her invitation, type the code from her phone, attest both statements (ADR-0021 slice 3) |

## How it is served

The clinic BFF serves the built portal from its own origin (`BFF_CLINIC_APP_DIR`) with a fresh CSP nonce per page. State changes send the session's CSRF token (delivered only in the `/v1/session` body) and JSON; the BFF also checks the exact Origin.

## Commands

- `pnpm --filter @endo/clinic-web dev`: Vite dev server, proxying `/v1` and `/auth` to the clinic BFF (`BFF_URL`, default `http://127.0.0.1:8081`).
- `pnpm --filter @endo/clinic-web build`: production build into `dist/` (about 96 KB of compressed JavaScript).
- `pnpm --filter @endo/clinic-web test`: unit tests for the portal logic (`src/portal/portal.ts`).
- `pnpm --filter @endo/clinic-web test:e2e`: builds, then drives the real clinic BFF and the built portal in headless Chromium; CSP violations fail the test.
