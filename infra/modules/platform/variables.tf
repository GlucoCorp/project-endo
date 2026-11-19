variable "namespace" {
  description = "Namespace for platform services."
  type        = string
  default     = "endo-platform"
}

variable "profile" {
  description = "local = slim single-node dev (one Postgres instance, OpenBao dev mode); shared = always-on dev on the organisation's own machine (ADR-0023)."
  type        = string
  validation {
    condition     = contains(["local", "shared"], var.profile)
    error_message = "profile must be local or shared."
  }
}

variable "keycloak_hostname" {
  description = "Public hostname for Keycloak (shared profile). Ignored for local."
  type        = string
  default     = ""
}

# Images pinned by digest (ADR-0014). Renovate proposes updates after the 7-day release age.
variable "images" {
  type = object({
    postgres = string
    keycloak = string
    openbao  = string
    mailpit  = string
  })
  default = {
    postgres = "postgres:18.6-alpine@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395"
    # ADR-0025: Keycloak with the Endo extension (the realm uses its providers). Locally:
    # docker build -t endo-keycloak:dev services/keycloak-extension && k3d image import -c endo-local endo-keycloak:dev
    # Elsewhere: the signed ghcr.io/glucocorp/endo-keycloak image, by digest (enforced in keycloak.tf).
    keycloak = "endo-keycloak:dev"
    openbao  = "quay.io/openbao/openbao:2.7.2@sha256:5046911075e137e154ce49ab051502f4ec7cf367d484ae4a4dce665d9b90561f"
    # ADR-0026: dev mail catcher (MIT).
    mailpit = "docker.io/axllent/mailpit:v1.27.0@sha256:fb84cfb1c3a33007cfdee8ba5a77b8c6c894de5b1a368372ddc5c965cf5c0b6d"
  }
}

variable "postgres_storage" {
  type    = string
  default = "2Gi"
}

variable "bff_base_urls" {
  description = "Public base URLs of the BFFs, used for exact OIDC redirect URIs in the Keycloak realm (no wildcards)."
  type = object({
    patient   = string
    clinician = string
  })
  default = {
    patient   = "http://localhost:3001"
    clinician = "http://localhost:3002"
  }
  validation {
    condition = alltrue([
      for u in values(var.bff_base_urls) :
      can(regex("^(https://[a-z0-9.-]+|http://localhost:[0-9]+)$", u))
    ])
    error_message = "BFF base URLs must be https://host or http://localhost:port, with no path or trailing slash."
  }
}

variable "mail_from" {
  description = "Sender address of code emails (ADR-0026). A neutral address: no product or health words."
  type        = string
  default     = "no-reply@localhost"
}

# ADR-0034: the application services. Off by default (platform only). Images are pinned by digest;
# make the "app-keys" Secret first: node tools/app-keys.mjs --namespace <ns> | kubectl apply -f -
variable "apps" {
  type = object({
    enabled     = optional(bool, false)
    environment = optional(string, "dev")
    images = optional(object({
      api         = string
      identity    = string
      bff_patient = string
      bff_clinic  = string
      integration = string
    }), { api = "", identity = "", bff_patient = "", bff_clinic = "", integration = "" })
    ruleset_path         = optional(string, "/app/clinical/rulesets/ruleset.1.0.0.json")
    ruleset_public_keys  = optional(string)
    integration_base_url = optional(string, "http://localhost:3003")
    security_contact     = optional(string)
    emergency_number     = optional(string)
    vapid_subject        = optional(string)
    smart_issuers = optional(list(object({
      iss       = string
      client_id = string
    })), [])
  })
  default = {}
  validation {
    condition     = contains(["dev", "test", "staging", "production"], var.apps.environment)
    error_message = "apps.environment must be dev, test, staging or production."
  }
}
