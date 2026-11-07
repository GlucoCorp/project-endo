# OpenBao (ADR-0014; replaces HashiCorp Vault from spec 17.3): secrets manager and, later, the
# Transit engine behind the KeyManager interface (packages/crypto, ADR-0009).
#
# local profile: dev mode (in-memory, auto-unsealed, random root token in a Secret). Data is lost
# on restart, which is acceptable for synthetic local development only.
# shared profile: server mode with integrated storage, initialisation and unseal keys handled by
# the shared-dev environment. Not built yet, so the module refuses that combination for now.

resource "terraform_data" "openbao_profile_guard" {
  lifecycle {
    precondition {
      condition     = var.profile == "local"
      error_message = "OpenBao server mode (shared profile) is not implemented yet; only the local profile is supported."
    }
  }
}

resource "random_password" "openbao_root_token" {
  length  = 40
  special = false
}

resource "kubernetes_secret_v1" "openbao" {
  metadata {
    name      = "openbao-dev-root-token"
    namespace = local.ns
  }
  data = {
    token = random_password.openbao_root_token.result
  }
}

resource "kubernetes_deployment_v1" "openbao" {
  metadata {
    name      = "openbao"
    namespace = local.ns
    labels    = { app = "openbao" }
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "openbao" }
    }
    template {
      metadata {
        labels = { app = "openbao" }
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 100
          run_as_group    = 1000
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "openbao"
          image             = var.images.openbao
          image_pull_policy = "IfNotPresent"
          args              = ["server", "-dev", "-dev-listen-address=0.0.0.0:8200"]
          env {
            name = "BAO_DEV_ROOT_TOKEN_ID"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.openbao.metadata[0].name
                key  = "token"
              }
            }
          }
          env {
            name  = "SKIP_SETCAP"
            value = "true" # no IPC_LOCK capability under PSA restricted; dev mode does not mlock
          }
          env {
            name  = "SKIP_CHOWN"
            value = "true"
          }
          env {
            name  = "HOME"
            value = "/tmp"
          }
          port {
            name           = "api"
            container_port = 8200
          }
          resources {
            requests = { cpu = "20m", memory = "48Mi" }
            limits   = { memory = "192Mi" }
          }
          readiness_probe {
            http_get {
              path = "/v1/sys/health"
              port = "api"
            }
            period_seconds = 5
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
            name       = "tmp"
            mount_path = "/tmp"
          }
        }
        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
  }
  wait_for_rollout = true
  depends_on       = [terraform_data.openbao_profile_guard]
}

resource "kubernetes_service_v1" "openbao" {
  metadata {
    name      = "openbao"
    namespace = local.ns
  }
  spec {
    selector = { app = "openbao" }
    port {
      name        = "api"
      port        = 8200
      target_port = "api"
    }
  }
}

resource "kubernetes_network_policy_v1" "openbao_ingress" {
  metadata {
    name      = "openbao-ingress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { app = "openbao" }
    }
    policy_types = ["Ingress"]
    ingress {
      from {
        pod_selector {
          match_labels = { "endo.glucorp.health/openbao" = "client" }
        }
      }
      ports {
        port     = "8200"
        protocol = "TCP"
      }
    }
  }
}
