# PostgreSQL (spec 8.3, 11.1, 17.3).
# - shared profile: separate instances for clinical, identity (+ Keycloak) and audit data (spec 2.4).
# - local profile: one instance with separate databases and roles, to fit a small dev machine.
# Every database is owned by its own role and closed to PUBLIC. Login roles (audit_api,
# clinical_api, clinical_relay, identity_api, identity_relay) are members of their store's group
# role and can connect only to their own database. The pg_roles Job keeps all of this in place.

locals {
  pg_instances = var.profile == "local" ? {
    main = ["clinical", "identity", "audit", "keycloak"]
    } : {
    clinical = ["clinical"]
    identity = ["identity", "keycloak"]
    audit    = ["audit"]
  }

  # database name -> instance that hosts it
  pg_host_of = merge([for inst, dbs in local.pg_instances : { for db in dbs : db => inst }]...)

  pg_databases = toset(flatten(values(local.pg_instances)))
}

resource "random_password" "pg_superuser" {
  for_each = local.pg_instances
  length   = 32
  special  = false
}

resource "random_password" "db_owner" {
  for_each = local.pg_databases
  length   = 32
  special  = false
}

resource "random_password" "audit_api" {
  length  = 32
  special = false
}

resource "random_password" "clinical_api" {
  length  = 32
  special = false
}

resource "random_password" "clinical_relay" {
  length  = 32
  special = false
}

resource "random_password" "identity_api" {
  length  = 32
  special = false
}

resource "random_password" "identity_relay" {
  length  = 32
  special = false
}

resource "kubernetes_secret_v1" "identity_api_url" {
  metadata {
    name      = "db-identity-api"
    namespace = local.ns
  }
  data = {
    url = "postgres://identity_api:${random_password.identity_api.result}@postgres-${local.pg_host_of["identity"]}.${local.ns}.svc:5432/identity"
  }
}

resource "kubernetes_secret_v1" "identity_relay_url" {
  metadata {
    name      = "db-identity-relay"
    namespace = local.ns
  }
  data = {
    url = "postgres://identity_relay:${random_password.identity_relay.result}@postgres-${local.pg_host_of["identity"]}.${local.ns}.svc:5432/identity"
  }
}

resource "kubernetes_secret_v1" "clinical_relay_url" {
  metadata {
    name      = "db-clinical-relay"
    namespace = local.ns
  }
  data = {
    url = "postgres://clinical_relay:${random_password.clinical_relay.result}@postgres-${local.pg_host_of["clinical"]}.${local.ns}.svc:5432/clinical"
  }
}

resource "kubernetes_secret_v1" "pg_bootstrap" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}-bootstrap"
    namespace = local.ns
  }
  data = merge(
    { POSTGRES_PASSWORD = random_password.pg_superuser[each.key].result },
    { for db in each.value : "${upper(db)}_OWNER_PASSWORD" => random_password.db_owner[db].result },
    contains(each.value, "audit") ? { AUDIT_API_PASSWORD = random_password.audit_api.result } : {},
    contains(each.value, "clinical") ? {
      CLINICAL_API_PASSWORD   = random_password.clinical_api.result
      CLINICAL_RELAY_PASSWORD = random_password.clinical_relay.result
    } : {},
    contains(each.value, "identity") ? {
      IDENTITY_API_PASSWORD   = random_password.identity_api.result
      IDENTITY_RELAY_PASSWORD = random_password.identity_relay.result
    } : {},
  )
}

# One connection secret per database role, for workloads and migration jobs.
resource "kubernetes_secret_v1" "db_owner_url" {
  for_each = local.pg_databases
  metadata {
    name      = "db-${each.key}-owner"
    namespace = local.ns
  }
  data = {
    url = "postgres://${each.key}_owner:${random_password.db_owner[each.key].result}@postgres-${local.pg_host_of[each.key]}.${local.ns}.svc:5432/${each.key}"
  }
}

resource "kubernetes_secret_v1" "audit_api_url" {
  metadata {
    name      = "db-audit-api"
    namespace = local.ns
  }
  data = {
    url = "postgres://audit_api:${random_password.audit_api.result}@postgres-${local.pg_host_of["audit"]}.${local.ns}.svc:5432/audit"
  }
}

resource "kubernetes_secret_v1" "clinical_api_url" {
  metadata {
    name      = "db-clinical-api"
    namespace = local.ns
  }
  data = {
    url = "postgres://clinical_api:${random_password.clinical_api.result}@postgres-${local.pg_host_of["clinical"]}.${local.ns}.svc:5432/clinical"
  }
}

# Databases, owners and login roles are reconciled by a Job on every apply whose scripts changed,
# on new and existing volumes alike (infra/modules/platform/postgres-roles/README.md). Group
# roles come from each store's bootstrap/roles.sql, the only list of them.
locals {
  repo_root  = "${path.module}/../../.."
  role_order = jsondecode(file("${path.module}/postgres-roles/order.json"))
  # instance -> ordered SQL files (paths from the repository root)
  pg_role_files = {
    for inst, dbs in local.pg_instances :
    inst => concat(local.role_order.common, flatten([for db in dbs : local.role_order.databases[db]]))
  }
}

resource "kubernetes_config_map_v1" "pg_roles" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}-roles"
    namespace = local.ns
  }
  # Helpers keep their names (the scripts include them with \ir); ordered files are keyed by their
  # repository path with "/" replaced, so files with the same name never collide.
  data = merge(
    { for f in local.role_order.helpers : basename(f) => file("${local.repo_root}/${f}") },
    { for f in local.pg_role_files[each.key] : replace(f, "/", "__") => file("${local.repo_root}/${f}") },
  )
}

resource "kubernetes_job_v1" "pg_roles" {
  for_each = local.pg_instances
  metadata {
    # A new name whenever the scripts or the passwords change, so the Job runs again (including
    # on rotation); otherwise it is left alone. Only a truncated hash of the secret is used.
    name = "postgres-${each.key}-roles-${substr(sha256(jsonencode([
      kubernetes_config_map_v1.pg_roles[each.key].data,
      sha256(jsonencode(kubernetes_secret_v1.pg_bootstrap[each.key].data)),
    ])), 0, 10)}"
    namespace = local.ns
  }
  spec {
    backoff_limit = 6
    template {
      metadata {
        labels = {
          app                                        = "postgres-roles"
          "endo.glucorp.health/postgres-${each.key}" = "client"
        }
      }
      spec {
        restart_policy                  = "OnFailure"
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 70
          run_as_group    = 70
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "reconcile"
          image             = var.images.postgres
          image_pull_policy = "IfNotPresent"
          command = concat(
            ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--dbname", "postgres"],
            flatten([for f in local.pg_role_files[each.key] : ["-f", "/sql/${replace(f, "/", "__")}"]]),
          )
          env {
            name  = "PGHOST"
            value = "postgres-${each.key}"
          }
          env {
            name  = "PGUSER"
            value = "endo_admin"
          }
          env {
            name  = "HOME"
            value = "/tmp"
          }
          env {
            name = "PGPASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.pg_bootstrap[each.key].metadata[0].name
                key  = "POSTGRES_PASSWORD"
              }
            }
          }
          # Login passwords, read by the scripts with \getenv (never on the command line).
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.pg_bootstrap[each.key].metadata[0].name
            }
          }
          resources {
            requests = { cpu = "10m", memory = "16Mi" }
            limits   = { memory = "64Mi" }
          }
          security_context {
            allow_privilege_escalation = local.hardened.allow_privilege_escalation
            read_only_root_filesystem  = true
            run_as_non_root            = true
            capabilities {
              drop = local.hardened.capabilities_drop
            }
          }
          volume_mount {
            name       = "sql"
            mount_path = "/sql"
            read_only  = true
          }
          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }
        }
        volume {
          name = "sql"
          config_map {
            name = kubernetes_config_map_v1.pg_roles[each.key].metadata[0].name
          }
        }
        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
  }
  wait_for_completion = true
  timeouts {
    create = "5m"
  }
  # Postgres must be running and reachable: its Service, DNS and both network policies.
  depends_on = [
    kubernetes_stateful_set_v1.postgres,
    kubernetes_service_v1.postgres,
    kubernetes_network_policy_v1.allow_dns,
    kubernetes_network_policy_v1.postgres_ingress,
    kubernetes_network_policy_v1.postgres_client_egress,
  ]
}

resource "kubernetes_stateful_set_v1" "postgres" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}"
    namespace = local.ns
    labels    = { app = "postgres", instance = each.key }
  }
  spec {
    service_name = "postgres-${each.key}"
    replicas     = 1
    selector {
      match_labels = { app = "postgres", instance = each.key }
    }
    template {
      metadata {
        labels = { app = "postgres", instance = each.key }
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 70 # postgres user in the alpine image
          run_as_group    = 70
          fs_group        = 70
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "postgres"
          image             = var.images.postgres
          image_pull_policy = "IfNotPresent"
          args = [
            "-c", "shared_buffers=${var.profile == "local" ? "64MB" : "256MB"}",
            "-c", "max_connections=${var.profile == "local" ? "50" : "100"}",
            "-c", "password_encryption=scram-sha-256",
            "-c", "log_statement=none", # never log SQL text: it can contain data (spec 2.3)
            # nor the text of a failed statement (data, or a password in ALTER ROLE)
            "-c", "log_min_error_statement=panic",
          ]
          env {
            name  = "POSTGRES_USER"
            value = "endo_admin"
          }
          env {
            name  = "PGDATA"
            value = "/var/lib/postgresql/data/pgdata"
          }
          # Only its own superuser password: login passwords go to the roles Job alone.
          env {
            name = "POSTGRES_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.pg_bootstrap[each.key].metadata[0].name
                key  = "POSTGRES_PASSWORD"
              }
            }
          }
          port {
            name           = "postgres"
            container_port = 5432
          }
          resources {
            requests = { cpu = "50m", memory = "96Mi" }
            limits   = { memory = var.profile == "local" ? "384Mi" : "2Gi" }
          }
          readiness_probe {
            exec {
              command = ["pg_isready", "-U", "endo_admin", "-d", "postgres"]
            }
            period_seconds = 5
          }
          liveness_probe {
            exec {
              command = ["pg_isready", "-U", "endo_admin", "-d", "postgres"]
            }
            initial_delay_seconds = 30
            period_seconds        = 15
          }
          security_context {
            allow_privilege_escalation = local.hardened.allow_privilege_escalation
            read_only_root_filesystem  = true
            run_as_non_root            = true
            capabilities {
              drop = local.hardened.capabilities_drop
            }
          }
          volume_mount {
            name       = "data"
            mount_path = "/var/lib/postgresql/data"
          }
          volume_mount {
            name       = "run"
            mount_path = "/var/run/postgresql"
          }
          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }
        }
        volume {
          name = "run"
          empty_dir {}
        }
        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
    volume_claim_template {
      metadata {
        name = "data"
      }
      spec {
        access_modes = ["ReadWriteOnce"]
        resources {
          requests = { storage = var.postgres_storage }
        }
      }
    }
  }
  wait_for_rollout = true
}

resource "kubernetes_service_v1" "postgres" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}"
    namespace = local.ns
  }
  spec {
    selector = { app = "postgres", instance = each.key }
    port {
      name        = "postgres"
      port        = 5432
      target_port = "postgres"
    }
  }
}

# Only pods labelled as clients of this instance may connect (default deny otherwise).
resource "kubernetes_network_policy_v1" "postgres_ingress" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}-ingress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { app = "postgres", instance = each.key }
    }
    policy_types = ["Ingress"]
    ingress {
      from {
        pod_selector {
          match_labels = { "endo.glucorp.health/postgres-${each.key}" = "client" }
        }
      }
      ports {
        port     = "5432"
        protocol = "TCP"
      }
    }
  }
}

# Matching egress: labelled clients may open connections to their Postgres instance only.
resource "kubernetes_network_policy_v1" "postgres_client_egress" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}-client-egress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { "endo.glucorp.health/postgres-${each.key}" = "client" }
    }
    policy_types = ["Egress"]
    egress {
      to {
        pod_selector {
          match_labels = { app = "postgres", instance = each.key }
        }
      }
      ports {
        port     = "5432"
        protocol = "TCP"
      }
    }
  }
}
