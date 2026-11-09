# Keycloak (spec 8.3, 10): identity provider. Its data lives on the identity Postgres instance.
# The dev realm (realm/endo-dev.json) is imported on first start: passkey-only browser flow,
# confidential BFF clients with PKCE, brute-force protection, spec 10 session limits.
# Import is skipped when the realm already exists; see infra/README.md to re-import.

locals {
  keycloak_pg         = local.pg_host_of["keycloak"]
  keycloak_public_url = var.profile == "local" ? "http://localhost:18080" : "https://${var.keycloak_hostname}"
}

resource "random_password" "keycloak_admin" {
  length  = 32
  special = false
}

resource "random_password" "oidc_client" {
  for_each = toset(["patient", "clinician"])
  length   = 48
  special  = false
}

resource "kubernetes_config_map_v1" "keycloak_realm" {
  metadata {
    name      = "keycloak-realm"
    namespace = local.ns
  }
  data = {
    "endo-dev.json" = file("${path.module}/realm/endo-dev.json")
  }
}

# Client secrets for the BFFs; each BFF reads only its own (M1 wiring).
resource "kubernetes_secret_v1" "oidc_client" {
  for_each = random_password.oidc_client
  metadata {
    name      = "oidc-bff-${each.key}"
    namespace = local.ns
  }
  data = {
    client_id     = "bff-${each.key}"
    client_secret = each.value.result
    issuer        = "${local.keycloak_public_url}/realms/endo-dev"
  }
}

resource "kubernetes_secret_v1" "keycloak" {
  metadata {
    name      = "keycloak"
    namespace = local.ns
  }
  data = {
    KC_DB_PASSWORD              = random_password.db_owner["keycloak"].result
    KC_BOOTSTRAP_ADMIN_PASSWORD = random_password.keycloak_admin.result
    # Placeholders resolved by Keycloak when importing realm/endo-dev.json.
    ENDO_BFF_PATIENT_CLIENT_SECRET     = random_password.oidc_client["patient"].result
    ENDO_BFF_CLINICIAN_CLIENT_SECRET   = random_password.oidc_client["clinician"].result
    ENDO_BFF_PATIENT_REDIRECT_URI      = "${var.bff_base_urls.patient}/auth/callback"
    ENDO_BFF_CLINICIAN_REDIRECT_URI    = "${var.bff_base_urls.clinician}/auth/callback"
    ENDO_BFF_PATIENT_POST_LOGOUT_URI   = "${var.bff_base_urls.patient}/"
    ENDO_BFF_CLINICIAN_POST_LOGOUT_URI = "${var.bff_base_urls.clinician}/"
    # ADR-0019: Keycloak notifies the clinic BFF when a clinician session ends.
    ENDO_BFF_CLINICIAN_BACKCHANNEL_LOGOUT_URI = "${var.bff_base_urls.clinician}/auth/backchannel-logout"
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
          args = [var.profile == "local" ? "start-dev" : "start", "--import-realm"]
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
            value = local.keycloak_public_url
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
          volume_mount {
            name       = "realm"
            mount_path = "/opt/keycloak/data/import"
            read_only  = true
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
        volume {
          name = "realm"
          config_map {
            name = kubernetes_config_map_v1.keycloak_realm.metadata[0].name
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
