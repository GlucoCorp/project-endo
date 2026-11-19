# Application services (ADR-0034): api, jobs, identity, bff-patient, bff-clinic and integration,
# in the platform namespace so the default-deny policies and the client labels below apply.
# Deployed only when var.apps.enabled. Keys come from the "app-keys" Secret made by
# tools/app-keys.mjs (never from OpenTofu state); database URLs and OIDC client secrets from the
# Secrets this module already makes. Each service gets exactly the credentials it uses.

locals {
  apps_on = var.apps.enabled
  realm   = "endo-dev"

  issuer_public   = "${local.keycloak_public_url}/realms/${local.realm}"
  issuer_internal = "http://keycloak:8080/realms/${local.realm}"
  oidc_internal   = "${local.issuer_internal}/protocol/openid-connect"
  oidc_public     = "${local.issuer_public}/protocol/openid-connect"

  # Postgres instances a pod connects to -> its client labels.
  pg_labels = { for svc, dbs in {
    api         = ["clinical", "audit"]
    jobs        = ["clinical"]
    identity    = ["identity", "audit"]
    bff-patient = ["sessions"]
    bff-clinic  = ["sessions"]
    integration = []
    } : svc => { for inst in distinct([for db in dbs : local.pg_host_of[db]]) :
  "endo.glucorp.health/postgres-${inst}" => "client" } }

  # Who may call whom (port 8080). The ingress controller reaches the three public services.
  app_callers = {
    api         = ["bff-patient", "bff-clinic", "identity", "integration"]
    identity    = ["api", "jobs", "bff-patient", "bff-clinic", "keycloak"]
    bff-patient = []
    bff-clinic  = []
    integration = []
  }
  app_public = ["bff-patient", "bff-clinic", "integration"]

  # Spec 11.2: each KMS client has its own OpenBao token and policy, limited to its Transit key.
  kms_keys = {
    api        = "endo-clinical"
    identity   = "endo-identity"
    bff-clinic = "endo-identity"
  }
  kms_env = {
    ENDO_KMS_OPENBAO_ADDR       = "http://openbao:8200"
    ENDO_KMS_OPENBAO_TOKEN_FILE = "/var/run/endo/openbao/token"
  }

  k   = "app-keys"
  env = var.apps.environment

  # Per workload: image, command, plain settings and settings from Secrets ([secret, key]).
  apps = { for name, app in {
    api = {
      image = var.apps.images.api
      args  = ["src/main.ts"]
      port  = true
      plain = merge(local.kms_env, {
        API_PORT                   = "8080"
        API_HOST                   = "0.0.0.0"
        ENDO_CLINICAL_RULESET_PATH = var.apps.ruleset_path
        API_IDENTITY_BASE_URL      = "http://identity:8080"
        }, var.apps.vapid_subject == null ? {} : { API_VAPID_SUBJECT = var.apps.vapid_subject },
        var.apps.ruleset_public_keys == null ? {} : { ENDO_RULESET_PUBLIC_KEYS = var.apps.ruleset_public_keys },
      )
      secret = {
        API_CLINICAL_DATABASE_URL               = ["db-clinical-api", "url"]
        API_AUDIT_DATABASE_URL                  = ["db-audit-api", "url"]
        API_AUDIT_RELAY_DATABASE_URL            = ["db-clinical-relay", "url"]
        API_WORKLOAD_PRIVATE_KEY_JWK            = [local.k, "api.private"]
        API_SERVICE_TOKEN_PUBLIC_KEY_JWK        = [local.k, "bff-patient-service.public"]
        API_BFF_CLINIC_SERVICE_PUBLIC_KEY_JWK   = [local.k, "bff-clinic-service.public"]
        API_BFF_CLINIC_WORKLOAD_PUBLIC_KEY_JWK  = [local.k, "bff-clinic.public"]
        API_BFF_PATIENT_WORKLOAD_PUBLIC_KEY_JWK = [local.k, "bff-patient.public"]
        API_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK    = [local.k, "identity.public"]
        API_INTEGRATION_WORKLOAD_PUBLIC_KEY_JWK = [local.k, "integration.public"]
        API_VAPID_PRIVATE_KEY_JWK               = [local.k, "vapid.private"]
      }
    }
    # ADR-0029: same image as the API, its own process and credentials.
    jobs = {
      image = var.apps.images.api
      args  = ["src/jobs-main.ts"]
      port  = false
      plain = { JOBS_IDENTITY_BASE_URL = "http://identity:8080" }
      secret = {
        JOBS_CLINICAL_DATABASE_URL    = ["db-clinical-jobs", "url"]
        JOBS_WORKLOAD_PRIVATE_KEY_JWK = [local.k, "jobs.private"]
      }
    }
    identity = {
      image = var.apps.images.identity
      args  = ["src/main.ts"]
      port  = true
      plain = merge(local.kms_env, {
        IDENTITY_PORT               = "8080"
        IDENTITY_HOST               = "0.0.0.0"
        IDENTITY_IDP_ISSUER         = local.issuer_public
        IDENTITY_KEYCLOAK_REALM_URL = local.issuer_internal
        IDENTITY_API_BASE_URL       = "http://api:8080"
      })
      secret = {
        IDENTITY_DATABASE_URL                       = ["db-identity-api", "url"]
        IDENTITY_AUDIT_DATABASE_URL                 = ["db-audit-api", "url"]
        IDENTITY_AUDIT_RELAY_DATABASE_URL           = ["db-identity-relay", "url"]
        IDENTITY_WORKLOAD_PRIVATE_KEY_JWK           = [local.k, "identity.private"]
        IDENTITY_TRUSTED_API_PUBLIC_KEY_JWK         = [local.k, "api.public"]
        IDENTITY_TRUSTED_JOBS_PUBLIC_KEY_JWK        = [local.k, "jobs.public"]
        IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK = [local.k, "bff-patient.public"]
        IDENTITY_TRUSTED_BFF_CLINIC_PUBLIC_KEY_JWK  = [local.k, "bff-clinic.public"]
        IDENTITY_TRUSTED_KEYCLOAK_PUBLIC_KEY_JWK    = [local.k, "keycloak.public"]
      }
    }
    bff-patient = {
      image = var.apps.images.bff_patient
      args  = ["src/main.ts"]
      port  = true
      plain = merge({
        BFF_PATIENT_PORT                        = "8080"
        BFF_PATIENT_HOST                        = "0.0.0.0"
        BFF_PATIENT_APP_DIR                     = "/app/web"
        BFF_PATIENT_ORIGIN                      = var.bff_base_urls.patient
        BFF_PATIENT_API_BASE_URL                = "http://api:8080"
        BFF_PATIENT_IDENTITY_BASE_URL           = "http://identity:8080"
        BFF_PATIENT_OIDC_ISSUER                 = local.issuer_public
        BFF_PATIENT_OIDC_AUTHORIZATION_ENDPOINT = "${local.oidc_public}/auth"
        BFF_PATIENT_OIDC_END_SESSION_ENDPOINT   = "${local.oidc_public}/logout"
        BFF_PATIENT_OIDC_TOKEN_ENDPOINT         = "${local.oidc_internal}/token"
        BFF_PATIENT_OIDC_JWKS_URI               = "${local.oidc_internal}/certs"
        }, var.apps.security_contact == null ? {} : { ENDO_SECURITY_CONTACT = var.apps.security_contact },
        var.apps.emergency_number == null ? {} : { BFF_PATIENT_EMERGENCY_NUMBER = var.apps.emergency_number },
      )
      secret = {
        BFF_PATIENT_SESSION_DATABASE_URL          = ["db-sessions-bff-patient", "url"]
        BFF_PATIENT_OIDC_CLIENT_SECRET            = ["oidc-bff-patient", "client_secret"]
        BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK      = [local.k, "bff-patient.private"]
        BFF_PATIENT_SERVICE_TOKEN_PRIVATE_KEY_JWK = [local.k, "bff-patient-service.private"]
        BFF_PATIENT_VAPID_PUBLIC_KEY              = [local.k, "vapid.public"]
      }
    }
    bff-clinic = {
      image = var.apps.images.bff_clinic
      args  = ["src/main.ts"]
      port  = true
      plain = merge(local.kms_env, {
        BFF_CLINIC_PORT                          = "8080"
        BFF_CLINIC_HOST                          = "0.0.0.0"
        BFF_CLINIC_APP_DIR                       = "/app/web"
        BFF_CLINIC_PORTAL_ORIGIN                 = var.bff_base_urls.clinician
        BFF_CLINIC_API_BASE_URL                  = "http://api:8080"
        BFF_CLINIC_IDENTITY_BASE_URL             = "http://identity:8080"
        BFF_CLINIC_OIDC_CLIENT_ID                = "bff-clinician"
        BFF_CLINIC_OIDC_ISSUER                   = local.issuer_public
        BFF_CLINIC_OIDC_AUTHORIZATION_ENDPOINT   = "${local.oidc_public}/auth"
        BFF_CLINIC_OIDC_END_SESSION_ENDPOINT     = "${local.oidc_public}/logout"
        BFF_CLINIC_OIDC_TOKEN_ENDPOINT           = "${local.oidc_internal}/token"
        BFF_CLINIC_OIDC_JWKS_URI                 = "${local.oidc_internal}/certs"
        BFF_CLINIC_OIDC_REDIRECT_URI             = "${var.bff_base_urls.clinician}/auth/callback"
        BFF_CLINIC_OIDC_POST_LOGOUT_REDIRECT_URI = "${var.bff_base_urls.clinician}/"
        }, var.apps.security_contact == null ? {} : { ENDO_SECURITY_CONTACT = var.apps.security_contact },
        length(var.apps.smart_issuers) == 0 ? {} : { BFF_CLINIC_SMART_ISSUERS = jsonencode(var.apps.smart_issuers) },
      )
      secret = {
        BFF_CLINIC_SESSION_DATABASE_URL          = ["db-sessions-bff-clinic", "url"]
        BFF_CLINIC_OIDC_CLIENT_SECRET            = ["oidc-bff-clinician", "client_secret"]
        BFF_CLINIC_WORKLOAD_PRIVATE_KEY_JWK      = [local.k, "bff-clinic.private"]
        BFF_CLINIC_SERVICE_TOKEN_PRIVATE_KEY_JWK = [local.k, "bff-clinic-service.private"]
      }
    }
    integration = {
      image = var.apps.images.integration
      args  = ["src/main.ts"]
      port  = true
      plain = {
        INTEGRATION_PORT         = "8080"
        INTEGRATION_HOST         = "0.0.0.0"
        INTEGRATION_BASE_URL     = var.apps.integration_base_url
        INTEGRATION_API_BASE_URL = "http://api:8080"
      }
      secret = {
        INTEGRATION_WORKLOAD_PRIVATE_KEY_JWK = [local.k, "integration.private"]
      }
    }
  } : name => app if local.apps_on }

  # Schema migrations run as each database's owner, from an image that contains its store.
  migrations = { for db, m in {
    audit    = { image = var.apps.images.api, script = "/app/packages/audit/src/migrate-cli.ts", env = "ENDO_AUDIT_MIGRATION_DATABASE_URL" }
    clinical = { image = var.apps.images.api, script = "/app/packages/clinical-store/src/migrate-cli.ts", env = "ENDO_CLINICAL_MIGRATION_DATABASE_URL" }
    identity = { image = var.apps.images.identity, script = "/app/packages/identity-store/src/migrate-cli.ts", env = "ENDO_IDENTITY_MIGRATION_DATABASE_URL" }
    sessions = { image = var.apps.images.bff_patient, script = "/app/packages/session-store/src/migrate-cli.ts", env = "ENDO_SESSION_MIGRATION_DATABASE_URL" }
  } : db => m if local.apps_on }
}

# ADR-0014: deployed images are pinned by digest. The local profile may use images built and
# imported on the machine (k3d image import), which have no registry digest.
resource "terraform_data" "apps_image_guard" {
  count = local.apps_on ? 1 : 0
  lifecycle {
    precondition {
      condition = var.profile == "local" || alltrue([
        for i in values(var.apps.images) : can(regex("^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$", i))
      ])
      error_message = "Outside the local profile every app image must be pinned by digest (name@sha256:...)."
    }
  }
}

resource "random_password" "openbao_app_token" {
  for_each = local.kms_keys
  length   = 40
  special  = false
}

resource "kubernetes_secret_v1" "openbao_app_token" {
  for_each = local.kms_keys
  metadata {
    name      = "openbao-token-${each.key}"
    namespace = local.ns
  }
  data = {
    token = random_password.openbao_app_token[each.key].result
  }
}

resource "kubernetes_job_v1" "migrate" {
  for_each = local.migrations
  metadata {
    # A new image is a new Job, so every release runs its migrations once.
    name      = "migrate-${each.key}-${substr(sha1(each.value.image), 0, 10)}"
    namespace = local.ns
  }
  spec {
    backoff_limit = 4
    template {
      metadata {
        labels = { "endo.glucorp.health/postgres-${local.pg_host_of[each.key]}" = "client" }
      }
      spec {
        restart_policy                  = "OnFailure"
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 65532
          run_as_group    = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = "migrate"
          image             = each.value.image
          image_pull_policy = "IfNotPresent"
          args              = [each.value.script]
          env {
            name = each.value.env
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.db_owner_url[each.key].metadata[0].name
                key  = "url"
              }
            }
          }
          resources {
            requests = { cpu = "50m", memory = "64Mi" }
            limits   = { memory = "256Mi" }
          }
          security_context {
            allow_privilege_escalation = local.hardened.allow_privilege_escalation
            read_only_root_filesystem  = true
            run_as_non_root            = true
            capabilities {
              drop = local.hardened.capabilities_drop
            }
          }
        }
      }
    }
  }
  wait_for_completion = true
  timeouts {
    create = "10m"
  }
  depends_on = [kubernetes_job_v1.pg_roles, kubernetes_network_policy_v1.postgres_client_egress]
}

resource "kubernetes_deployment_v1" "app" {
  for_each = local.apps
  metadata {
    name      = each.key
    namespace = local.ns
    labels    = { app = each.key, "endo.glucorp.health/app" = each.key }
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = each.key }
    }
    template {
      metadata {
        labels = merge(
          { app = each.key, "endo.glucorp.health/app" = each.key },
          local.pg_labels[each.key],
          contains(keys(local.kms_keys), each.key) ? { "endo.glucorp.health/openbao" = "client" } : {},
          { for target, callers in local.app_callers : "endo.glucorp.health/${target}" => "client" if contains(callers, each.key) },
          startswith(each.key, "bff-") || each.key == "identity" ? { "endo.glucorp.health/keycloak" = "client" } : {},
        )
      }
      spec {
        automount_service_account_token = false
        security_context {
          run_as_non_root = true
          run_as_user     = 65532
          run_as_group    = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        container {
          name              = each.key
          image             = each.value.image
          image_pull_policy = "IfNotPresent"
          args              = each.value.args
          env {
            name  = "ENDO_ENV"
            value = local.env
          }
          dynamic "env" {
            for_each = each.value.plain
            content {
              name  = env.key
              value = env.value
            }
          }
          dynamic "env" {
            for_each = each.value.secret
            content {
              name = env.key
              value_from {
                secret_key_ref {
                  name = env.value[0]
                  key  = env.value[1]
                }
              }
            }
          }
          dynamic "port" {
            for_each = each.value.port ? [1] : []
            content {
              name           = "http"
              container_port = 8080
            }
          }
          dynamic "readiness_probe" {
            for_each = each.value.port ? [1] : []
            content {
              http_get {
                path = "/healthz"
                port = "http"
              }
              period_seconds = 10
            }
          }
          dynamic "liveness_probe" {
            for_each = each.value.port ? [1] : []
            content {
              http_get {
                path = "/healthz"
                port = "http"
              }
              initial_delay_seconds = 20
              period_seconds        = 20
            }
          }
          resources {
            requests = { cpu = "25m", memory = "96Mi" }
            limits   = { memory = "384Mi" }
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
            for_each = contains(keys(local.kms_keys), each.key) ? [1] : []
            content {
              name       = "openbao-token"
              mount_path = "/var/run/endo/openbao"
              read_only  = true
            }
          }
        }
        volume {
          name = "tmp"
          empty_dir {
            size_limit = "64Mi"
          }
        }
        dynamic "volume" {
          for_each = contains(keys(local.kms_keys), each.key) ? [1] : []
          content {
            name = "openbao-token"
            secret {
              secret_name  = kubernetes_secret_v1.openbao_app_token[each.key].metadata[0].name
              default_mode = "0440"
            }
          }
        }
      }
    }
  }
  wait_for_rollout = false
  depends_on = [
    kubernetes_job_v1.migrate,
    kubernetes_job_v1.openbao_transit,
    kubernetes_secret_v1.bff_sessions_url,
    kubernetes_secret_v1.clinical_jobs_url,
  ]
}

resource "kubernetes_service_v1" "app" {
  for_each = { for k, v in local.apps : k => v if v.port }
  metadata {
    name      = each.key
    namespace = local.ns
  }
  spec {
    selector = { app = each.key }
    port {
      name        = "http"
      port        = 8080
      target_port = "http"
    }
  }
}

# Ingress: listed callers (and the ingress controller, for public services) on port 8080 only.
resource "kubernetes_network_policy_v1" "app_ingress" {
  for_each = { for k, v in local.apps : k => v if v.port }
  metadata {
    name      = "${each.key}-ingress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { app = each.key }
    }
    policy_types = ["Ingress"]
    dynamic "ingress" {
      for_each = length(local.app_callers[each.key]) > 0 ? [1] : []
      content {
        from {
          pod_selector {
            match_labels = { "endo.glucorp.health/${each.key}" = "client" }
          }
        }
        ports {
          port     = "8080"
          protocol = "TCP"
        }
      }
    }
    dynamic "ingress" {
      for_each = contains(local.app_public, each.key) ? [1] : []
      content {
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
}

# Matching egress for callers of each internal service, and of Keycloak.
resource "kubernetes_network_policy_v1" "app_client_egress" {
  for_each = local.apps_on ? toset(["api", "identity", "keycloak"]) : toset([])
  metadata {
    name      = "${each.key}-client-egress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { "endo.glucorp.health/${each.key}" = "client" }
    }
    policy_types = ["Egress"]
    egress {
      to {
        pod_selector {
          match_labels = { app = each.key }
        }
      }
      ports {
        port     = "8080"
        protocol = "TCP"
      }
    }
  }
}

# Spec 16.2: the clinic BFF fetches SMART configuration from record systems' public endpoints
# (HTTPS only, never private addresses). Present only when issuers are configured.
resource "kubernetes_network_policy_v1" "bff_clinic_smart_egress" {
  count = local.apps_on && length(var.apps.smart_issuers) > 0 ? 1 : 0
  metadata {
    name      = "bff-clinic-smart-egress"
    namespace = local.ns
  }
  spec {
    pod_selector {
      match_labels = { app = "bff-clinic" }
    }
    policy_types = ["Egress"]
    egress {
      to {
        ip_block {
          cidr   = "0.0.0.0/0"
          except = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]
        }
      }
      ports {
        port     = "443"
        protocol = "TCP"
      }
    }
  }
}
