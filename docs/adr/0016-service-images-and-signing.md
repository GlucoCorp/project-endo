# ADR-0016: Service images, SBOMs and keyless signing

- Status: accepted
- Date: 2026-11-08
- Requirements/Risks: spec 12.4, 17, 18.2, M0 exit criterion ("SBOM and signed image produced"); RISK-T02, RISK-T04

## Context

M0 must produce signed images with SBOMs. The organisation is on GitHub Free with a private repository and has no budget. Spec 12.4 asks for cosign signatures, CycloneDX SBOMs and verification before deployment; spec 2 rule 8 forbids long-lived secrets in CI. Options were researched independently (Codex, read-only) and checked against GitHub and Sigstore documentation:

| Option                                                  | Cost                               | Stored secret        | What becomes public                                                       | Available now                |
| ------------------------------------------------------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| **Sigstore keyless (GitHub OIDC, public Fulcio/Rekor)** | free                               | none                 | repo name, workflow path, branch, commit and run IDs (certificate fields) | yes                          |
| cosign key in OpenBao Transit, CI authenticates by OIDC | free (Oracle VM)                   | key held in OpenBao  | nothing                                                                   | no: needs the shared-dev VM  |
| cosign key in an Actions secret                         | free                               | long-lived key in CI | nothing                                                                   | conflicts with spec 2 rule 8 |
| GitHub artifact attestations                            | Enterprise Cloud for private repos | none                 | nothing                                                                   | no                           |

## Decision

1. **One Dockerfile for all services** (repo root, `--build-arg SERVICE=...`). Build stage `node:24.22.2-trixie-slim`; runtime `gcr.io/distroless/nodejs24-debian13:nonroot` (Node 24.22.2, matching `.nvmrc`). Both pinned by digest. Only the service's production dependency closure is installed and copied (`pnpm install --frozen-lockfile --prod --filter-prod @endo/<service>...`, then exactly the workspace projects in that closure); lifecycle scripts stay disabled.
2. **Runtime hardening.** No shell or package manager; runs as uid 65532; `/app` and everything in it are created as root and are read-only to that user; works with a read-only root filesystem and all capabilities dropped. Services listen on loopback unless `*_HOST=0.0.0.0` is set, which containers do; NetworkPolicy then controls reach (ADR-0014).
3. **Pull requests** build each image, fail on HIGH/CRITICAL vulnerabilities or secrets (Trivy), and keep a CycloneDX SBOM for 14 days.
4. **main** builds, fails on HIGH/CRITICAL vulnerabilities or secrets, pushes to **private GHCR** (`ghcr.io/glucocorp/endo-<service>`, currently free for container images), generates the CycloneDX SBOM from the pushed digest, signs it with **cosign keyless**, attaches the CycloneDX SBOM as a signed attestation, and verifies both against the exact identity `.github/workflows/images.yml@refs/heads/main`. Only that job has `packages: write` and `id-token: write`.
5. **Public metadata accepted.** The product owner accepted on 2026-11-08 that keyless signing publishes the fields above to Sigstore's public, permanent logs. Nothing else is published.
6. **Deployers verify before running** (spec 12.4), by digest:
   `cosign verify --certificate-identity https://github.com/GlucoCorp/project-endo/.github/workflows/images.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/glucocorp/endo-api@sha256:...`
   and the same with `verify-attestation --type cyclonedx`. Admission enforcement in k3s (Sigstore policy-controller) comes with the shared-dev environment, after testing bundle compatibility.

7. **Debian security fixes ahead of the base image.** When Trivy finds a fixed Debian vulnerability that the pinned distroless rebuild does not yet contain, the `os-patches` stage downloads Debian's update (apt verifies the archive signature and package checksum), unpacks it over the base and updates the package record, so scanners see the real version. Each entry names its CVEs and a minimum version, and is removed when Renovate moves the base to a rebuild with the fix. Security fixes from Debian's signed archive are not held back by the 7-day release-age rule. First use: `zlib1g` (CVE-2026-76844, CVE-2026-85091), 2026-11-08.
8. **CI smoke-tests every image** under `--read-only --cap-drop ALL` as uid 65532 before scanning it.

## Consequences

- **Trust rests on who can change `main`.** GitHub Free has no branch protection for private repos, so anyone with write access could change the signing workflow on `main` and get valid signatures. `main-guard` detects commits that did not come from a merged PR (RISK-T04); keep write access minimal.
- **This is not SLSA level 3.** Provenance is not yet produced in an isolated builder. Signed BuildKit provenance is a later step.
- **Pulling private images** from the Oracle VM needs a credential. A permanent personal access token in `imagePullSecrets` is not acceptable; the shared-dev design will push verified images into the cluster from an authorised workflow instead.
- **arm64** images are needed for the Oracle Ampere VM; added with the shared-dev environment.
- GitHub may change GHCR billing with a month's notice. If so, revisit (OCI archives in private releases are the fallback).
- If the signing metadata must become private later, move to OpenBao Transit signing (row 2) without changing the verification step's shape.

## Dependencies

| Item                                            | Version               | Licence                                  | Notes                                                                                                                                                       |
| ----------------------------------------------- | --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node` image (build stage only)                 | 24.22.2-trixie-slim   | MIT (Node), Debian packages              | digest-pinned                                                                                                                                               |
| `gcr.io/distroless/nodejs24-debian13` (runtime) | nonroot, Node 24.22.2 | Apache-2.0 (distroless), Debian packages | digest-pinned; rebuilt images of the aged Node release are accepted (ADR-0014 policy)                                                                       |
| `sigstore/cosign-installer` action              | v4.1.2 (`6f9f177`)    | Apache-2.0                               | v4.1.3 under 7 days                                                                                                                                         |
| cosign                                          | v3.0.6                | Apache-2.0                               | the installer's bootstrap version, checked against a digest pinned in the action (no second download); v3.1.4 release assets were unreachable on 2026-11-08 |
