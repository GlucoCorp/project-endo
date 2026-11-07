# infra/

Zero-cost infrastructure (ADR-0014): **OpenTofu** modules deploying the spec 17.3 self-hosted stack (k3s, PostgreSQL, Keycloak, OpenBao) to any Kubernetes cluster. **Synthetic data only** in every environment here.

| Path                     | What                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `k3d/endo-local.yaml`    | Local k3s cluster in Docker, bound to 127.0.0.1                                                    |
| `modules/platform/`      | Namespaces (Pod Security `restricted`), default-deny network policies, Postgres, Keycloak, OpenBao |
| `envs/local/`            | Local environment (slim profile, ~1.8 GB RAM)                                                      |
| `envs/shared-dev/`       | Planned: always-on k3s on an Oracle Cloud Always Free VM (needs an Oracle account)                 |
| `dev/docker-compose.yml` | Older quick database stack for ad-hoc tests                                                        |

## Local environment

Needs Docker Desktop, plus `k3d`, `kubectl` and OpenTofu (`tofu`).

```sh
k3d cluster create --config infra/k3d/endo-local.yaml
tofu -chdir=infra/envs/local init
tofu -chdir=infra/envs/local apply           # first Keycloak start takes 3–7 minutes

# Reach a service from your machine (loopback only):
kubectl --context k3d-endo-local -n endo-platform port-forward --address 127.0.0.1 svc/postgres-main 55432:5432
kubectl --context k3d-endo-local -n endo-platform port-forward --address 127.0.0.1 svc/keycloak 58080:8080

# Credentials are generated and stored as Kubernetes Secrets, for example:
kubectl --context k3d-endo-local -n endo-platform get secret db-audit-owner -o jsonpath='{.data.url}'   # base64

# Apply the audit schema, then run the API against it as the least-privilege role:
ENDO_AUDIT_MIGRATION_DATABASE_URL=<db-audit-owner url via 127.0.0.1:55432> pnpm --filter @endo/audit migrate
API_AUDIT_DATABASE_URL=<db-audit-api url via 127.0.0.1:55432> ...

tofu -chdir=infra/envs/local destroy   # tear down
k3d cluster delete endo-local
```

What the local profile enforces (verified):

- Pods without the client label cannot reach Postgres (default-deny NetworkPolicy).
- Each database is owned by its own role and closed to PUBLIC. `clinical_owner` cannot connect to `audit`.
- The API connects as `audit_api` (SELECT and INSERT only). It cannot delete audit rows, and fails closed (500) if the audit database is unreachable.
- Containers run non-root with all capabilities dropped. Kubernetes Secrets are encrypted at rest.

## Rules

- State files contain generated credentials: they are git-ignored and never committed. `.terraform.lock.hcl` **is** committed (provider checksums).
- Images are pinned by digest; providers by exact version (ADR-0014 lists both, with the 7-day release-age rule).
