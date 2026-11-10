# ADR-0014: Zero-cost infrastructure — OpenTofu, k3s, OpenBao

- Status: accepted; the `shared-dev` environment is superseded by ADR-0023 (self-hosted, WireGuard)
- Date: 2026-11-08
- Requirements/Risks: spec 8.1, 11.1, 12.5, 12.6, 17.1–17.4; RISK-T02, RISK-I01

## Context

The organisation has **no budget for recurring infrastructure costs**. Spec 17.2 describes an AWS reference deployment that bills monthly. Spec 17.3 also requires a self-hostable stack for Kenya and Rwanda (Kubernetes such as k3s, PostgreSQL, Keycloak, HashiCorp Vault, MinIO), with cloud services behind interfaces (8.1).

The development machine has 7.8 GB of RAM and 4 CPUs (Docker Desktop: about 3.7 GB, 4 CPUs).

## Decision

### Tooling: OpenTofu, not Terraform

OpenTofu (Linux Foundation, MPL-2.0) is the open-source fork of Terraform, with the same language and providers. Terraform has moved to the Business Source Licence, which is outside our allowlist. Spec 8.3 already says "Terraform (OpenTofu compatible)". Pinned: **OpenTofu 1.13.2** (1.13.8 and 1.13.9 were under 7 days old and contain only non-security bug fixes).

### Platform: the spec 17.3 stack first, everywhere

We build the **self-hosted stack** from spec 17.3 first. It costs nothing, and it is the hardest deployment target, so building it first de-risks Kenya and Rwanda.

| Spec 17.3 component | Choice                            | Licence                 | Why                                                                                                                       |
| ------------------- | --------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes (k3s)    | **k3s v1.37.1** (k3d locally)     | Apache-2.0              | As specified; v1.37.2 was under 7 days old                                                                                |
| PostgreSQL          | **postgres 18.6** official image  | PostgreSQL (permissive) | As specified                                                                                                              |
| Keycloak            | **Keycloak 26.8.1**               | Apache-2.0              | As specified; 26.8.2 was under 7 days old                                                                                 |
| HashiCorp Vault     | **OpenBao 2.7.2** instead         | MPL-2.0                 | Vault is now BSL, outside our licence allowlist. OpenBao is the Linux Foundation fork with the same API                   |
| MinIO               | **Deferred; SeaweedFS candidate** | Apache-2.0              | MinIO is AGPL and no longer ships free community builds. Object storage is first needed for exports (M5) and backups (M6) |

### Environments

| Environment     | Where                                                                                                                              | Cost | Purpose                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `local`         | k3d (k3s in Docker) on the developer machine                                                                                       | free | Offline development. **Slim profile:** one Postgres instance with separate `clinical`, `identity`, `audit` and `keycloak` databases and separate roles, tight memory limits, OpenBao in dev mode |
| `shared-dev`    | **Superseded by ADR-0023:** k3s on a machine the organisation owns, reached only over WireGuard (was: Oracle Cloud Always Free VM) | free | Always-on for the team. **Full profile:** separate Postgres instances per store (spec 2.4), OpenBao in server mode                                                                               |
| `aws-reference` | Spec 17.2 modules, written and checked (`tofu validate`, Checkov), **never applied** until there is a customer or funding          | free | Keeps the AWS path ready                                                                                                                                                                         |

All environments use **synthetic data only** (spec 0 rule 2, 17.1). Production hosting for real patient data is decided at pilot time (spec Section 24 item 8).

### Version and image policy

- Every image is pinned by digest; every provider version is pinned and its checksums are recorded in `.terraform.lock.hcl` for the Linux and Windows platforms.
- The 7-day minimum release age applies to the **upstream release** (for example PostgreSQL 18.6, released 2026-08-11). Official images are rebuilt for base-OS patches more often than that; a rebuilt image of an aged release is accepted, pinned by digest, and Renovate keeps it current.

### Hardening in every profile

- Pod Security Admission `restricted` on our namespaces; containers run non-root, drop all capabilities, use the `RuntimeDefault` seccomp profile and a read-only root filesystem where the image allows.
- Default-deny NetworkPolicies, with explicit allows per flow.
- Every Service listens inside the cluster only. Local port-forwards bind to 127.0.0.1; the shared VM exposes only HTTPS (443) and SSH from the operator's IP.
- Generated credentials live only in Kubernetes Secrets and OpenTofu state. State is local and git-ignored for `local`; it is encrypted with OpenTofu state encryption for `shared-dev`.

## Consequences

- **Oracle account (superseded by ADR-0023, no longer needed):** creating one is a human step (it needs a card for identity checks; Always Free resources never bill unless the account is upgraded). Oracle may reclaim Always Free VMs that stay almost idle for 7 days; the cluster's scheduled jobs keep it above that threshold.
- **Free Oracle capacity:** Ampere A1 capacity in some regions is sometimes exhausted. Pick a region with capacity, or retry.
- **RAM on the dev machine:** the local profile is sized for about 2 GB inside Docker.
- **Spec deviations:** OpenBao instead of Vault and deferring MinIO are recorded here and in spec Section 24.

## Alternatives considered

- AWS free tier: expires after 12 months and is easy to exceed; rejected for a zero-budget team.
- Docker Compose only: free, but does not exercise the Kubernetes deployment the spec requires for Kenya and Rwanda; kept for quick database tests only.
- Hetzner or other cheap VPS (~€4/month): not free.

## Dependencies (tools and providers; none ship in our application)

| Item                          | Version | Licence                                        | Supply-chain notes                                         |
| ----------------------------- | ------- | ---------------------------------------------- | ---------------------------------------------------------- |
| OpenTofu                      | 1.13.2  | MPL-2.0 (reviewed: tool only, not distributed) | Installed via winget; hash matched the official SHA256SUMS |
| k3d                           | 5.9.0   | MIT                                            | winget; hash matched official checksums                    |
| kubectl                       | 1.37.2  | Apache-2.0                                     | winget; hash matched dl.k8s.io                             |
| Helm                          | 4.3.1   | Apache-2.0                                     | winget; hash matched get.helm.sh                           |
| Provider hashicorp/kubernetes | 3.4.0   | MPL-2.0 (reviewed)                             | 3.5.0 under 7 days                                         |
| Provider hashicorp/random     | 3.9.1   | MPL-2.0 (reviewed)                             |                                                            |
| Provider oracle/oci           | dropped | n/a                                            | Never pinned; not needed since ADR-0023                    |
