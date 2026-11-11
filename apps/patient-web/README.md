# @endo/patient-web

**Purpose:** the woman's app, an installable PWA (spec 14, 21.7). Built with React, Vite and TanStack Router (ADR-0024), styled only with `@endo/ui` tokens, all text from `@endo/i18n`.

**Owners:** patient experience team; security-relevant changes (CSP, storage, enrolment) need security review.

## Public API (screens)

| Path     | Screen                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/enrol` | Welcome and enrolment (ADR-0021 slice 2): the link `…/enrol#<token>` is read from the fragment and removed at once; Start (serialised across tabs with Web Locks); the code to show the clinic, updating by itself; the confirmed state |
| `/`      | Until sign-in exists, says to open the clinic's link                                                                                                                                                                                    |

## How it is served

The patient BFF serves the built app from its own origin (`BFF_PATIENT_APP_DIR`), so `/v1` calls are same-origin. Each page response gets a fresh CSP nonce; the build has no inline scripts and no `eval`, and runs under Trusted Types. Assets are cached as immutable.

## Commands

- `pnpm --filter @endo/patient-web dev`: Vite dev server on 127.0.0.1, proxying `/v1` to the BFF (`BFF_URL`, default `http://127.0.0.1:8080`).
- `pnpm --filter @endo/patient-web build`: production build into `dist/` (first load is about 95 KB of compressed JavaScript; budget 150 KB, spec 14).
- `pnpm --filter @endo/patient-web test`: unit tests for the page logic (`src/enrol/flow.ts`).
- `pnpm --filter @endo/patient-web test:e2e`: builds, then drives the real BFF and the built app in headless Chromium: CSP violations fail the test.
