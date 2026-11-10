# ADR-0024: Frontend stack for the patient and clinician apps

- Status: accepted (product owner, 2026-11-10, including the Unlicense for `isbot`)
- Date: 2026-11-10
- Requirements/Risks: spec 0 rule 3, 12.2, 12.4, 14, 18.2, 21; ADR-0003 (supply chain), ADR-0010 (licences); RISK-T02

## Context

ADR-0021 slice 2 needs its first screen: the patient's enrolment landing page. Spec 8 (repository layout and stack table) already chooses **React + Vite, TanStack Router and Query**, with CSS Modules over the tokens in `packages/ui` (#34). Spec 0 rule 3 still requires an ADR for each new dependency: why, alternatives, maintainer health, licence and supply-chain risk. This is that ADR. It does not reopen the choice of framework; it records exact versions and the risks of adding them.

Constraints that shape it:

- **Spec 14:** under 150 KB of compressed JavaScript on the check-in route; interactive within 3 seconds on a mid-range Android phone over 3G.
- **Spec 12.2:** a strict CSP with `script-src 'self' 'strict-dynamic'` and Trusted Types, no third-party scripts or fonts, no CDN.
- **ADR-0003:** exact pins, versions at least 7 days old, no install scripts, Renovate updates.
- **Spec 18.2:** production dependencies only under MIT, Apache-2.0, BSD or ISC (CC0-1.0 already added); MPL-2.0 only after review, and only for dev tooling.

## Decision

### Runtime (shipped to the browser)

Versions are the newest released at least 7 days before this ADR. Renovate proposes updates under the same rule.

| Package                  | Version  | Licence | Dependencies (all checked)                                                                                                                                            | Maintainers and health                                                                                                      |
| ------------------------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `react`, `react-dom`     | 19.3.1   | MIT     | `scheduler` (MIT)                                                                                                                                                     | React core team (React Foundation); the most widely used UI library; regular releases and security process                  |
| `@tanstack/react-router` | 1.170.46 | MIT     | `@tanstack/history`, `router-core`, `react-store`, `store` (MIT); `seroval`, `seroval-plugins`, `cookie-es`, `use-sync-external-store` (MIT); **`isbot` (Unlicense)** | TanStack (Tanner Linsley and core maintainers), sponsored; frequent releases; type-safe routes                              |
| `@tanstack/react-query`  | 5.105.3  | MIT     | `@tanstack/query-core` (MIT)                                                                                                                                          | TanStack, as above. **Added when the first screen fetches more than a single request**; the landing page uses plain `fetch` |

### Build and types (development only, never shipped)

| Package                            | Version | Licence | Notes                                                                                                                                                                                         |
| ---------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite`                             | 8.3.5   | MIT     | **Already in the lockfile** through Vitest. Its `rolldown` and `lightningcss` (MPL-2.0, reviewed in ADR-0010) ship prebuilt native binaries as optional dependencies, with no install scripts |
| `@vitejs/plugin-react`             | 6.2.1   | MIT     | One dependency (`@rolldown/pluginutils`, MIT)                                                                                                                                                 |
| `@types/react`, `@types/react-dom` | 19.3.0  | MIT     | Type definitions only                                                                                                                                                                         |

### Fonts (assets, not packages)

Atkinson Hyperlegible Next and Literata (spec 21.3), both under the **SIL Open Font Licence 1.1**, which allows bundling and self-hosting with an application. Downloaded once from the designers' official releases, checksums recorded, committed as WOFF2 under the app, served from our own origin. No font CDN (spec 2.1).

### Choices within the stack

- **Styling:** CSS Modules and the `@endo/ui` tokens. No component library or CSS framework (spec 21.11).
- **PWA:** a hand-written service worker that caches only the app shell, fonts and static assets (spec 14). No Workbox or PWA plugin: the rules are short and must be exact (never cache PHI).
- **No other runtime dependencies** without a further ADR. The first app's bundle is measured in CI against the spec 14 budget.

### Licence decision for `isbot`

`isbot`, which TanStack Router uses to detect crawlers, is released under the **Unlicense**: a public-domain dedication with a permissive fallback, OSI-approved, and in effect the same as CC0-1.0, which spec 18.2's allowlist already contains. **Accepted:** `Unlicense` is added to the allowlist in `tools/check-licences.mjs`, for the same reason CC0-1.0 is there.

## Consequences

- **Bundle:** React and React DOM are about 60 KB compressed, TanStack Router about 25 KB and Query about 13 KB, which leaves about 50 KB for the app on the check-in route. A CI size check enforces the budget when the first app lands. If it is ever exceeded, Preact with `preact/compat` (MIT, about 4 KB) is the fallback.
- **CSP:** Vite production builds emit no inline scripts or `eval`, so they work under `script-src 'self'` with Trusted Types. The dev server is never exposed beyond localhost.
- **Supply chain:** about 14 new packages in total (the table above plus transitive dependencies), all exact-pinned, at least 7 days old, with no install scripts, covered by OSV-Scanner, Trivy and the licence check, and updated by Renovate.
- **Tests for UI** (Testing Library, axe-core, which is MPL-2.0 and dev-only) get their own short ADR when the first component tests are written.

## Alternatives considered

- **Preact:** about 10 times smaller than React and MIT. Kept as the fallback if the budget is ever at risk. Not chosen now because the spec names React, and TanStack's React bindings and the wider testing tools target React first.
- **Svelte or SolidJS:** small and fast, but a different ecosystem from the one the spec chose, with fewer SMART on FHIR examples for the clinician app.
- **No framework (plain TypeScript and DOM):** smallest of all, but two full apps with keyboard-heavy clinician screens would rebuild much of what React and the router already provide.
- **React Router instead of TanStack Router:** MIT and widely used, but its type safety for route parameters and search state is weaker, and the spec chose TanStack.
