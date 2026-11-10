# infra/

Zero-cost infrastructure (ADR-0014): **OpenTofu** modules deploying the spec 17.3 self-hosted stack (k3s, PostgreSQL, Keycloak, OpenBao) to any Kubernetes cluster. **Synthetic data only** in every environment here.

| Path                     | What                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `k3d/endo-local.yaml`    | Local k3s cluster in Docker, bound to 127.0.0.1                                                    |
| `modules/platform/`      | Namespaces (Pod Security `restricted`), default-deny network policies, Postgres, Keycloak, OpenBao |
| `envs/local/`            | Local environment (slim profile, ~1.8 GB RAM)                                                      |
| `envs/shared-dev/`       | Planned: always-on k3s on a machine the organisation owns, reached only over WireGuard (ADR-0023)  |
| `dev/docker-compose.yml` | Older quick database stack for ad-hoc tests                                                        |

## Local environment

Needs Docker Desktop, plus `k3d`, `kubectl` and OpenTofu (`tofu`).

```sh
k3d cluster create --config infra/k3d/endo-local.yaml
tofu -chdir=infra/envs/local init
tofu -chdir=infra/envs/local apply           # first Keycloak start takes 3–7 minutes

# Reach a service from your machine (loopback only):
kubectl --context k3d-endo-local -n endo-platform port-forward --address 127.0.0.1 svc/postgres-main 15432:5432
kubectl --context k3d-endo-local -n endo-platform port-forward --address 127.0.0.1 svc/keycloak 18080:8080

# Credentials are generated and stored as Kubernetes Secrets, for example:
kubectl --context k3d-endo-local -n endo-platform get secret db-audit-owner -o jsonpath='{.data.url}'   # base64

# Apply the audit schema, then run the API against it as the least-privilege role:
ENDO_AUDIT_MIGRATION_DATABASE_URL=<db-audit-owner url via 127.0.0.1:15432> pnpm --filter @endo/audit migrate
API_AUDIT_DATABASE_URL=<db-audit-api url via 127.0.0.1:15432> ...

tofu -chdir=infra/envs/local destroy   # tear down
k3d cluster delete endo-local
```

What the local profile enforces (verified):

- Pods without the client label cannot reach Postgres (default-deny NetworkPolicy).
- Each database is owned by its own role and closed to PUBLIC. `clinical_owner` cannot connect to `audit`.
- The API connects as `audit_api` (SELECT and INSERT only). It cannot delete audit rows, and fails closed (500) if the audit database is unreachable.
- Containers run non-root with all capabilities dropped. Kubernetes Secrets are encrypted at rest.

## Keycloak dev realm

`modules/platform/realm/endo-dev.json` is imported on Keycloak's first start (ADR-0015): passkey-only sign-in with user verification, no passwords or self-registration, confidential BFF clients with PKCE and exact redirect URIs. `pnpm check:realm` guards these settings in CI.

- Each BFF's client id, secret and issuer are in the Secret `oidc-bff-patient` / `oidc-bff-clinician`.
- Admin console: `http://localhost:18080/admin/` after the port-forward above; the bootstrap admin password is in the Secret `keycloak` (`KC_BOOTSTRAP_ADMIN_PASSWORD`).
- Import skips a realm that already exists. To apply realm file changes locally, delete the realm in the admin console (or `tofu destroy` and `apply`) and restart Keycloak: `kubectl --context k3d-endo-local -n endo-platform rollout restart deploy/keycloak`.

Local ports are below 49152 on purpose: Windows reserves random blocks of the dynamic range (49152 and up) for Hyper-V and WSL, which makes port-forwards there fail after a reboot.

## Databases and roles

Every `tofu apply` whose role scripts changed runs the `postgres-<instance>-roles` Job, on new and existing volumes alike (`infra/modules/platform/postgres-roles/`). The Job:

- creates any missing database and closes it to PUBLIC;
- creates any missing role: owners, the stores' group roles from `packages/*/bootstrap/roles.sql`, and login roles;
- sets each login's password from the current secret, so rotating a password in OpenTofu takes effect (the Job reruns when a password changes, and workloads that read a password from their environment, such as Keycloak, roll out after it);
- strips any attribute beyond LOGIN.

When a migration needs a new role, add it to the store's `bootstrap/roles.sql` (and, for a login, to the database's file in `postgres-roles/`), run `tofu apply`, then migrate. `tools/check-postgres-roles.mjs` runs the same scripts in CI.

The scripts add what is missing; they do not revoke grants made by hand. The CI check fails if any login can reach another store's database.

## Rules

- State files contain generated credentials: they are git-ignored and never committed. `.terraform.lock.hcl` **is** committed (provider checksums).
- Images are pinned by digest; providers by exact version (ADR-0014 lists both, with the 7-day release-age rule).
