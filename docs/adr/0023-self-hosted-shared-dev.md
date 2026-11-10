# ADR-0023: The always-on dev environment runs on our own machine, reached over WireGuard

- Status: accepted (product owner, 2026-11-10: "switch from Oracle to an open-source option"); **building it is deferred** while one person builds alone (the `local` environment covers that)
- Date: 2026-11-10
- Supersedes: the `shared-dev` row of ADR-0014 (Oracle Cloud Always Free)
- Requirements/Risks: spec 0 rule 2, 2.1, 12.5, 17.1, 17.3; spec Section 24 item 16; RISK-I01, RISK-T04

## Context

ADR-0014 placed the always-on `shared-dev` environment on an Oracle Cloud Always Free VM. That needs an Oracle account (with a card for identity checks), depends on one vendor's free tier and its capacity, and may be reclaimed when idle. The product owner asked for an open-source option instead. Nothing for `shared-dev` had been built yet.

## Decision

`shared-dev` runs on **hardware the organisation already owns**, with only open-source software, and is **never exposed to the public internet**.

| Part            | Choice                                                                                                                                                                                        | Licence                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Machine         | One always-on x86-64 machine the organisation owns (a spare PC or mini PC; 16 GB RAM or more, SSD). No arm64 images needed                                                                    | n/a                             |
| OS              | Debian 13 (stable), unattended security updates, full-disk encryption                                                                                                                         | DFSG free software              |
| Kubernetes      | k3s, the same version as `local` (ADR-0014)                                                                                                                                                   | Apache-2.0                      |
| Access          | **WireGuard**: the team connects to a private network; the machine opens no other port to the internet                                                                                        | GPL-2.0 (kernel), tools MIT/GPL |
| TLS             | A private certificate authority for the dev domain (`*.endo.dev.internal`), its root installed on team devices. Passkeys (WebAuthn) need HTTPS; a private CA gives it without a public domain | tool chosen when built (ADR)    |
| Everything else | As ADR-0014: the full profile (separate Postgres per store, OpenBao in server mode), synthetic data only                                                                                      | as ADR-0014                     |

- **Reaching it:** if every team member is on the same network, no port is opened at all. Otherwise exactly one UDP port is forwarded to WireGuard, which answers nothing without a valid peer key.
- **Keys:** one WireGuard key pair per person and device, listed in the infrastructure repository by public key only. Removing a person removes their peer.
- **State:** OpenTofu state for `shared-dev` stays encrypted (ADR-0014). Backups of the machine follow spec 17.4 when the environment is built.
- **Synthetic data only**, as every non-production environment (spec 0 rule 2). This machine is never used for real patient data. Production hosting is still decided at pilot time (spec Section 24 item 8).

## Consequences

- No account, card, vendor free tier or idle-reclaim risk. The cost is the machine's electricity and someone keeping it on.
- **A person must choose and set up the machine** (spec Section 24 item 16, now: which machine, and who looks after it). Until then, `local` (k3d) remains the only environment.
- No public HTTPS endpoint, so nothing for an attacker on the internet to reach; Let's Encrypt and DuckDNS are no longer needed.
- Testing from phones (passkeys) needs the WireGuard app and the private CA root on each test phone. Both are free.
- ADR-0016's arm64 images (for the Oracle Ampere VM) are no longer needed.
- `infra/modules/platform` keeps its `shared` profile; only its description changes.

## Alternatives considered

- **Oracle Cloud Always Free:** works, but needs a vendor account and card, may be reclaimed, and is not open source. Replaced at the product owner's request.
- **A public endpoint on our machine (port forward plus Let's Encrypt):** needs a public domain or a free dynamic-DNS service, and exposes the login pages to the internet. A private network is safer for a dev environment.
- **Headscale (open-source Tailscale control server):** easier device enrolment, but one more service to run and secure. Plain WireGuard is enough for a small team; revisit if the team grows.
