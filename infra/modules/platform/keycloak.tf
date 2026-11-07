# Keycloak (spec 8.3, 10): identity provider. Its data lives on the identity Postgres instance.
# Realm configuration (clients, WebAuthn policy, MFA) is applied separately (M1).

locals {
  keycloak_pg = local.pg_host_of["keycloak"]
}

resource "random_password" "keycloak_admin" {
  length  = 32
  special = false
}

resource "kubernetes_secret_v1" "keycloak" {
  metadata {
    name      = "keycloak"
    namespace = local.ns
  }
  data = {
    KC_DB_PASSWORD              = random_password.db_owner["keycloak"].result
    KC_BOOTSTRAP_ADMIN_PASSWORD = random_password.keycloak_admin.result
  }
}

resource "kubernetes_deployment_v1" "keycloak" {
  metadata {
    name      = "keycloak"
    namespace = local.ns
    labels    = { app = "keycloak" }
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "keycloak" }
    }
    template {
      metadata {
        labels = {
          app                                                 = "keycloak"
          "endo.glucorp.health/postgres-${local.keycloak_pg}" = "client"
        }
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 0
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "keycloak"
          image             = var.images.keycloak
          image_pull_policy = "IfNotPresent"
          # start-dev locally (no TLS, relaxed hostname); production mode behind TLS ingress when shared.
          args = var.profile == "local" ? ["start-dev"] : ["start"]
          env {
            name  = "KC_DB"
            value = "postgres"
          }
          env {
            name  = "KC_DB_URL"
            value = "jdbc:postgresql://postgres-${local.keycloak_pg}.${local.ns}.svc:5432/keycloak"
          }
          env {
            name  = "KC_DB_USERNAME"
            value = "keycloak_owner"
          }
          env {
            name  = "KC_BOOTSTRAP_ADMIN_USERNAME"
            value = "endo-admin"
          }
          env {
            name  = "KC_HEALTH_ENABLED"
            value = "true"
          }
          env {
            name  = "KC_HTTP_ENABLED"
            value = "true" # TLS terminates at the ingress (shared) or the loopback port-forward (local)
          }
          env {
            name  = "KC_HOSTNAME"
            value = var.profile == "local" ? "http://localhost:58080" : "https://${var.keycloak_hostname}"
          }
          env {
            name  = "KC_PROXY_HEADERS"
            value = "xforwarded"
          }
          env {
            name  = "KC_LOG_LEVEL"
            value = "info"
          }
          env {
            name  = "JAVA_OPTS_KC_HEAP"
            value = "-XX:MaxRAMPercentage=65 -XX:InitialRAMPercentage=20"
          }
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.keycloak.metadata[0].name
            }
          }
          port {
            name           = "http"
            container_port = 8080
          }
          port {
            name           = "management"
            container_port = 9000
          }
          resources {
            requests = { cpu = "100m", memory = "384Mi" }
            limits   = { memory = var.profile == "local" ? "768Mi" : "1536Mi" }
          }
          startup_probe {
            http_get {
              path = "/health/started"
              port = "management"
            }
            period_seconds    = 5
            failure_threshold = 60 # first start builds the server; allow up to 5 minutes
          }
          readiness_probe {
            http_get {
              path = "/health/ready"
              port = "management"
            }
            period_seconds = 10
          }
          liveness_probe {
            http_get {
              path = "/health/live"
              port = "management"
            }
            period_seconds = 20
          }
          security_context {
            allow_privilege_escalation = local.hardened.allow_privilege_escalation
            # Keycloak writes its optimised build into the image directory at startup.
            read_only_root_filesystem = false
            run_as_non_root           = true
            capabilities {
              drop = local.hardened.capabilities_drop
            }
          }
        }
      }
    }
  }
  wait_for_rollout = true
  timeouts {
    create = "10m"
    update = "10m"
  }
  depends_on = [kubernetes_stateful_set_v1.postgres]
}

resource "kubernetes_service_v1" "keycloak" {
  metadata {
    name      = "keycloak"
    namespace = local.ns
  }
  spec {
    selector = { app = "keycloak" }
    port {
      name        = "http"
      port        = 8080
      target_port = "http"
    }
  }
}

resource "kubernetes_network_policy_v1" "keycloak_ingress" {
  metadata {
    name      = "keycloak-ingress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { app = "keycloak" }
    }
    policy_types = ["Ingress"]
    ingress {
      # BFFs (M1) and the ingress controller (shared profile) may reach Keycloak's HTTP port.
      from {
        pod_selector {
          match_labels = { "endo.glucorp.health/keycloak" = "client" }
        }
      }
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "kube-system" }
        }
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "traefik" }
        }
      }
      ports {
        port     = "8080"
        protocol = "TCP"
      }
    }
  }
}
