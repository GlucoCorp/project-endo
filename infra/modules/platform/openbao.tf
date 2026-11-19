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

# Spec 11.2: the Transit engine and one key per logical KMS key (packages/crypto TRANSIT_KEY).
# Idempotent: re-running enables nothing twice and never rotates or deletes a key.
resource "kubernetes_job_v1" "openbao_transit" {
  metadata {
    name      = "openbao-transit-setup"
    namespace = local.ns
  }
  spec {
    backoff_limit = 6
    template {
      metadata {
        labels = { "endo.glucorp.health/openbao" = "client" }
      }
      spec {
        restart_policy                  = "OnFailure"
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
          name              = "setup"
          image             = var.images.openbao
          image_pull_policy = "IfNotPresent"
          command = ["/bin/sh", "-ec", <<-SH
            bao secrets list -format=json | grep -q '"transit/"' || bao secrets enable transit
            for k in endo-identity endo-clinical endo-audit endo-objects endo-analytics endo-backup; do
              bao read "transit/keys/$k" >/dev/null 2>&1 || bao write -f "transit/keys/$k" type=aes256-gcm96
              # Keys may never be exported or deleted (crypto-shredding is per patient, spec 11.2).
              bao write "transit/keys/$k/config" deletion_allowed=false exportable=false >/dev/null
            done
            # Spec 11.2: one policy and token per KMS client, limited to minting and unwrapping data
            # keys under its own Transit key (no default policy: not even token self-lookup).
            # Custom token ids are the dev-mode delivery path (OpenBao warns they are hashed with
            # SHA-1); server mode will use Kubernetes auth instead (spec Section 24).
            for entry in $KMS_CLIENTS; do
              svc="$${entry%%=*}"; key="$${entry#*=}"
              {
                echo 'path "transit/datakey/plaintext/'"$key"'" { capabilities = ["update"] }'
                echo 'path "transit/decrypt/'"$key"'" { capabilities = ["update"] }'
              } | bao policy write "endo-$svc" - >/dev/null
              tok="$(cat "/tokens/$svc/token")"
              bao token lookup "$tok" >/dev/null 2>&1 || bao token create -id="$tok" -policy="endo-$svc" -no-default-policy -orphan -ttl=768h -display-name="$svc" >/dev/null 2>&1
            done
          SH
          ]
          env {
            name  = "BAO_ADDR"
            value = "http://openbao:8200"
          }
          env {
            name = "BAO_TOKEN"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.openbao.metadata[0].name
                key  = "token"
              }
            }
          }
          env {
            name  = "HOME"
            value = "/tmp"
          }
          env {
            name  = "KMS_CLIENTS"
            value = join(" ", [for svc, key in local.kms_keys : "${svc}=${key}"])
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
            name       = "tmp"
            mount_path = "/tmp"
          }
          dynamic "volume_mount" {
            for_each = local.kms_keys
            content {
              name       = "token-${volume_mount.key}"
              mount_path = "/tokens/${volume_mount.key}"
              read_only  = true
            }
          }
        }
        volume {
          name = "tmp"
          empty_dir {}
        }
        dynamic "volume" {
          for_each = local.kms_keys
          content {
            name = "token-${volume.key}"
            secret {
              secret_name = kubernetes_secret_v1.openbao_app_token[volume.key].metadata[0].name
            }
          }
        }
      }
    }
  }
  wait_for_completion = true
  timeouts {
    create = "5m"
  }
  depends_on = [kubernetes_deployment_v1.openbao, kubernetes_network_policy_v1.openbao_client_egress]
}

# Pods labelled as OpenBao clients may reach it (the namespace denies all egress by default).
resource "kubernetes_network_policy_v1" "openbao_client_egress" {
  metadata {
    name      = "openbao-client-egress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { "endo.glucorp.health/openbao" = "client" }
    }
    policy_types = ["Egress"]
    egress {
      to {
        pod_selector {
          match_labels = { app = "openbao" }
        }
      }
      ports {
        port     = "8200"
        protocol = "TCP"
      }
    }
  }
}
