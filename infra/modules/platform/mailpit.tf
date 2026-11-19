# ADR-0026: Mailpit catches Keycloak's email locally (dev and tests only). It never relays out:
# no relay is configured, and it is reachable only inside the namespace. Deployments use the
# self-hosted Postfix relay instead (infrastructure slice).
resource "kubernetes_deployment_v1" "mailpit" {
  metadata {
    name      = "mailpit"
    namespace = local.ns
    labels    = { app = "mailpit" }
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "mailpit" }
    }
    template {
      metadata {
        labels = { app = "mailpit" }
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "mailpit"
          image             = var.images.mailpit
          image_pull_policy = "IfNotPresent"
          # In memory only: caught messages disappear when the pod restarts.
          args = ["--smtp", "0.0.0.0:1025", "--listen", "0.0.0.0:8025", "--database", ""]
          port {
            name           = "smtp"
            container_port = 1025
          }
          port {
            name           = "http"
            container_port = 8025
          }
          resources {
            requests = { cpu = "10m", memory = "16Mi" }
            limits   = { memory = "96Mi" }
          }
          security_context {
            allow_privilege_escalation = local.hardened.allow_privilege_escalation
            read_only_root_filesystem  = true
            run_as_non_root            = true
            capabilities {
              drop = local.hardened.capabilities_drop
            }
          }
          # Mailpit keeps its message store in a temporary file even with `--database ""`; the
          # root filesystem is read-only, so /tmp is a small memory-backed scratch volume.
          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }
        }
        volume {
          name = "tmp"
          empty_dir {
            medium     = "Memory"
            size_limit = "32Mi"
          }
        }
      }
    }
  }
  wait_for_rollout = true
}

resource "kubernetes_service_v1" "mailpit" {
  metadata {
    name      = "mailpit"
    namespace = local.ns
  }
  spec {
    selector = { app = "mailpit" }
    port {
      name        = "smtp"
      port        = 1025
      target_port = "smtp"
    }
    port {
      name        = "http"
      port        = 8025
      target_port = "http"
    }
  }
}
