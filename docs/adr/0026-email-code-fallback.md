# ADR-0026: Email one-time code fallback, and how email is sent

- Status: **proposed**. It needs the product owner's approval: it adds a runtime component (a mail server) and a dev tool image (spec 0 rule 3).
- Date: 2026-11-11
- Requirements/Risks: spec 2.1, 10.1, 12.4, 18.2, Section 24 item 17; ADR-0015, ADR-0017 section 4, ADR-0021, ADR-0023; REQ-001, RISK-S04

## Context

Spec 10.1 makes passkeys primary and an email one-time code the fallback: 6 digits, 10-minute expiry, rate-limited. Section 24 item 17 is already decided: the identity service issues and verifies the codes, and a narrow Keycloak extension signs her in (ADR-0017 section 4). One question is still open: **how the email is sent**, with no budget and no third party processing identity data (spec 2.1: her email address is identity data and must not leave the region).

There is also a gap: enrolment never asks for an email address. Many patients have none (ADR-0017), so the fallback is only offered to a woman who has added and confirmed one.

## Options for sending

| Option                                                                                                                         | New dependency                                                    | Third party sees her address | Cost                 | Deliverability                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| A. Hosted email API (SES, Postmark, Brevo free tier)                                                                           | an SDK or nodemailer                                              | **yes**, a processor         | free tier, then paid | good                                                                                         |
| B. **Keycloak's built-in SMTP sender** (the extension calls `EmailTemplateProvider`), to **our own mail server** in the region | none in code; a **Postfix** container (or similar) in deployments | no                           | zero                 | needs SPF, DKIM, DMARC and a clean IP; outbound port 25 is often blocked on home connections |
| C. Our own SMTP client in the identity service (Node `net`/`tls`), to our own mail server                                      | none, but security-critical protocol code to maintain             | no                           | zero                 | as B                                                                                         |
| D. nodemailer (MIT, no dependencies) in the identity service, to our own mail server                                           | nodemailer                                                        | no                           | zero                 | as B                                                                                         |

## Proposed decision

**B: Keycloak sends the email through its own SMTP sender, to a self-hosted mail server in the region.**

- **No new code dependency.** Keycloak already ships an audited SMTP client with TLS, configured per realm. The extension already exists (ADR-0025) and only uses the SPI.
- **No third party sees the address.** The mail server runs beside Keycloak (ADR-0023 self-hosting). In production it relays only to the recipient's own mail server.
- **The identity service still owns the code (Section 24 item 17).** It draws the code, stores only its MAC (as for the confirmation code, ADR-0021 section 3), enforces the limits, and verifies it. Keycloak only delivers the message, which contains the code and no PHI, and then signs her in through the same back-channel pattern as enrolment.

### Flow

1. On the sign-in page she chooses "Email me a code". The extension asks the identity service (workload scope `identity.email-code.keycloak`) to issue a code for the address she typed.
2. The identity service answers the same way whether or not the address belongs to a patient, so it can't be used to find out who is a patient. Only when the address belongs to exactly one patient with a confirmed email does it create a code: 6 digits, 10 minutes, single use, MAC only. It returns the code to the extension for delivery and nothing else.
3. Keycloak emails the code to the address the identity service holds for her, never to the address she typed.
4. She types the code. The extension asks the identity service to verify it (5 wrong entries lock the code), then signs her in as that user. The BFF's sign-in callback is unchanged.
5. **Limits:** 3 codes per address per hour and 10 per client IP per hour. Every issue, verification, failure and lock is audited, with no address or code in the event.

### Her email address

- **Added in settings** after enrolment (spec 21.7 screen 9), confirmed by a link or code sent the same way, and stored encrypted under her own key (identity vault; `person.email` already exists).
- A code never goes to an unconfirmed address.

### Dev and tests

- **Mailpit** (MIT; single static Go binary image, pinned by digest) catches mail locally and in CI e2e. It never relays out.

### Deployment

- **Postfix** (IPL-1.0/EPL-2.0, mature, widely packaged) in a pinned image, alongside Keycloak.
- **Sending rules:** TLS required to the recipient where available, DKIM signing, and SPF and DMARC records for the sending domain. Only Keycloak can submit mail to it.
- If the host's port 25 is blocked, email fallback is unavailable in that deployment, and passkeys still work. A paid relay would need a new ADR and a processor agreement.

## Consequences

- **Built once approved:**
  - the identity routes and store (codes, limits, audit);
  - the extension's authenticator (`endo-email-code`) and realm flow changes, checked by `check:realm`;
  - email confirmation in settings, and Mailpit in `infra/dev`.
- **Licences:** Postfix (IPL-1.0 and EPL-2.0) and Mailpit (MIT) are images, not linked code. IPL-1.0 isn't on the 18.2 allowlist, so the product owner's approval of this ADR covers it, as with ADR-0024.
- **Risks:**
  - Deliverability on self-hosted IPs is uncertain, so the fallback may land in spam. Mitigation: DKIM, SPF and DMARC, and passkeys stay primary.
  - An email inbox is a weaker factor than a passkey. The fallback never recovers an account on its own (spec 10.1). After a code sign-in, the app prompts her to create a new passkey.

## Not chosen

- **A (hosted API):** a third party would process identity data.
- **C (our own SMTP client):** protocol and security code we'd have to maintain, for what Keycloak already does.
- **D (nodemailer):** a new runtime dependency in the identity service, while B needs none.
