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

## Upgrading an existing database

The Postgres first-boot script creates roles only on a new volume. When a migration needs a new role (for example `endo_clinical_membership_lookup`, migration 0004), run the idempotent bootstrap scripts as a privileged role before migrating:

```sh
psql "$PRIVILEGED_URL" -v ON_ERROR_STOP=1 -f packages/clinical-store/bootstrap/roles.sql
psql "$PRIVILEGED_URL" -v ON_ERROR_STOP=1 -v owner=clinical_owner -f packages/clinical-store/bootstrap/grant-owner.sql
```

A new **login** role needs its password too. Identity migration 0002 adds the outbox relay. After `tofu apply`, take `IDENTITY_RELAY_PASSWORD` from the bootstrap secret of the instance hosting the identity database (`postgres-main-bootstrap` in the local profile, `postgres-identity-bootstrap` otherwise), then on the identity database:

```sh
psql "$PRIVILEGED_URL" -v ON_ERROR_STOP=1 -f packages/identity-store/bootstrap/roles.sql
psql "$PRIVILEGED_URL" -v ON_ERROR_STOP=1 -v pw="$IDENTITY_RELAY_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE identity_relay LOGIN PASSWORD %L IN ROLE endo_identity_relay', :'pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_relay') \gexec
GRANT CONNECT ON DATABASE identity TO identity_relay;
SQL
```

This manual step is a known gap. Before the first deployed environment, a role reconciliation job will apply all roles idempotently on every apply.

## Rules

- State files contain generated credentials: they are git-ignored and never committed. `.terraform.lock.hcl` **is** committed (provider checksums).
- Images are pinned by digest; providers by exact version (ADR-0014 lists both, with the 7-day release-age rule).
