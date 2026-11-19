# ADR-0034: Deploying the application services

- **Status:** accepted (decided under the product owner's delegation, 2026-11-16)
- **Requirements:** spec 12.4, 12.5, 11.2, 17.3; ADR-0014, ADR-0016, ADR-0029, ADR-0033

## Context

The platform module ran Postgres, Keycloak, OpenBao and Mailpit, but none of the services. Each service needs its own database login, its own workload key and its callers' public keys, and the KMS clients need OpenBao access. Spec 12.5 asks for no long-lived secrets in code or state where it can be avoided, and least privilege for every credential.

## Decision

1. The services run in the platform namespace (`infra/modules/platform/apps.tf`), switched on by `var.apps.enabled`, so the namespace's default-deny policies and the existing client labels apply. One Dockerfile builds every image; the two BFF images also contain their built web app (a throwaway build stage; only static files reach the runtime image).
2. **Keys** are made by `tools/app-keys.mjs` and piped to `kubectl apply`: Ed25519 workload keys for every caller, the two BFFs' service-token keys, Keycloak's extension key and the VAPID pair. They never enter OpenTofu state, the repository or a file, and the tool refuses to print to a terminal. Each pod reads only its own private key and the public keys it verifies.
3. **Databases**: each service has its own login (the jobs process gets `clinical_jobs`, separate from the API's). Migrations run as each database's owner in a Job named after the image, before the services roll out.
4. **KMS**: the OpenBao setup Job writes a policy per KMS client (`api`, `identity`, `bff-clinic`) that allows only `datakey/plaintext` and `decrypt` on its own Transit key, and a token with that policy and no default policy. The token is mounted as a file. In dev mode tokens are created with ids from OpenTofu (OpenBao hashes custom ids with SHA-1); server mode will use the Kubernetes auth method instead (spec Section 24 item 44).
5. **Network**: callers of `api`, `identity` and Keycloak carry a client label and are the only pods allowed in; the public services accept the ingress controller only. The clinic BFF may reach public HTTPS addresses (never private ranges) only when SMART issuers are configured.
6. Pods: non-root, read-only root filesystem, all capabilities dropped, no service account token, `/healthz` probes.

## Consequences

- Key rotation is a re-run of the tool and a rollout restart; every key changes at once.
- On the local profile all databases share one Postgres instance, so the network label reaches all of them and database roles do the separation; the shared profile has separate instances.
- Still open (spec Section 24 item 44): OpenBao Kubernetes auth, Ingress and TLS for the shared profile, the Keycloak image with the extension, more than one replica.
