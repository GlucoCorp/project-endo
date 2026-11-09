# ADR-0020: Playwright for browser tests

- Status: accepted (product owner approved the dependency and the browser download, 2026-11-09)
- Date: 2026-11-09
- Requirements/Risks: spec 18 (testing), ADR-0019 slice 7; RISK-S01

## Context

Clinician sign-in depends on browser behaviour that unit tests cannot show: a cross-site OIDC callback, then a same-origin page that makes the browser send a `SameSite=Strict` session cookie, and that cookie _not_ being sent when the portal is reached from another site. Spec 18 also plans Playwright end-to-end tests for enrolment, check-ins and quick exit.

## Decision

- `@playwright/test` **1.64.1** (Apache-2.0, maintained by Microsoft, very widely used) as a **development dependency** of `services/bff-clinic` only. 1.65.0 was under 7 days old. It is never part of a service image.
- It brings `playwright` and `playwright-core` (Apache-2.0) and no install scripts. Browsers are downloaded separately by its CLI from Playwright's official CDN.
- Headless Chromium only. CI and documentation use `playwright install --only-shell chromium` (the ~190 MB headless shell), not the full browser.
- Browser tests live in `e2e/`, run with `pnpm --filter @endo/bff-clinic test:e2e`, and use a stand-in identity provider on `127.0.0.1` while the portal runs on `localhost`, so the browser treats them as different sites.

## Alternatives considered

- Puppeteer: Chromium-focused, smaller ecosystem for test running; Playwright also covers WebKit, which spec 18 asks for later.
- Only unit tests: cannot prove SameSite cookie behaviour.

## Consequences

- Locally, the first `playwright install chromium` without `--only-shell` also downloaded the full browser (about 300 MB) alongside the headless shell; use `--only-shell`.
- The real-Keycloak passkey test (slice 7b) needs a registered passkey, which only the Keycloak enrolment add-on can create. It follows that add-on and will use Chromium's WebAuthn virtual authenticator.
