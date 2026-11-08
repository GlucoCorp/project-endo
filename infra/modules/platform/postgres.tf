# PostgreSQL (spec 8.3, 11.1, 17.3).
# - shared profile: separate instances for clinical, identity (+ Keycloak) and audit data (spec 2.4).
# - local profile: one instance with separate databases and roles, to fit a small dev machine.
# Every database is owned by its own role and closed to PUBLIC. The audit database also gets
# `audit_api`, a login role that is a member of endo_audit_app (SELECT and INSERT only, ADR-0013).
# The clinical database gets `clinical_api` (member of endo_clinical_app) and endo_clinical_lookup,
# which owns the one cross-organisation lookup; neither group role can log in (ADR-0017).

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

resource "kubernetes_config_map_v1" "pg_init" {
  for_each = local.pg_instances
  metadata {
    name      = "postgres-${each.key}-init"
    namespace = local.ns
  }
  # Built from a list of lines: template loop directives inside a heredoc leave indentation behind,
  # and the shell only ends the inner heredoc on a line that is exactly "EOSQL".
  data = {
    "10-databases.sh" = join("\n", concat(
      [
        "#!/bin/sh",
        "# Runs once, on first initialisation of the data directory.",
        "set -eu",
        "psql -v ON_ERROR_STOP=1 --username \"$POSTGRES_USER\" --dbname postgres <<EOSQL",
        "REVOKE ALL ON DATABASE postgres FROM PUBLIC;",
      ],
      flatten([for db in each.value : [
        "CREATE ROLE ${db}_owner LOGIN PASSWORD '$${${upper(db)}_OWNER_PASSWORD}';",
        "CREATE DATABASE ${db} OWNER ${db}_owner;",
        "REVOKE ALL ON DATABASE ${db} FROM PUBLIC;",
        "GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${db}_owner;",
      ]]),
      contains(each.value, "audit") ? [
        "CREATE ROLE endo_audit_app NOLOGIN;",
        "CREATE ROLE audit_api LOGIN PASSWORD '$${AUDIT_API_PASSWORD}' IN ROLE endo_audit_app;",
        "GRANT CONNECT ON DATABASE audit TO audit_api;",
      ] : [],
      # Same roles as packages/clinical-store/bootstrap/roles.sql (plain statements: this script
      # runs once, and the shell would expand the $$ in that file's DO block).
      contains(each.value, "clinical") ? [
        "CREATE ROLE endo_clinical_app NOLOGIN;",
        "CREATE ROLE endo_clinical_lookup NOLOGIN;",
        "GRANT endo_clinical_lookup TO clinical_owner;",
        "CREATE ROLE clinical_api LOGIN PASSWORD '$${CLINICAL_API_PASSWORD}' IN ROLE endo_clinical_app;",
        "GRANT CONNECT ON DATABASE clinical TO clinical_api;",
        "CREATE ROLE endo_clinical_relay NOLOGIN;",
        "CREATE ROLE clinical_relay LOGIN PASSWORD '$${CLINICAL_RELAY_PASSWORD}' IN ROLE endo_clinical_relay;",
        "GRANT CONNECT ON DATABASE clinical TO clinical_relay;",
      ] : [],
      ["EOSQL", ""],
    ))
  }
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
          ]
          env {
            name  = "POSTGRES_USER"
            value = "endo_admin"
          }
          env {
            name  = "PGDATA"
            value = "/var/lib/postgresql/data/pgdata"
          }
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.pg_bootstrap[each.key].metadata[0].name
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
          volume_mount {
            name       = "init"
            mount_path = "/docker-entrypoint-initdb.d"
            read_only  = true
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
        volume {
          name = "init"
          config_map {
            name         = kubernetes_config_map_v1.pg_init[each.key].metadata[0].name
            default_mode = "0555"
          }
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
