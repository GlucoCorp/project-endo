variable "namespace" {
  description = "Namespace for platform services."
  type        = string
  default     = "endo-platform"
}

variable "profile" {
  description = "local = slim single-node dev (one Postgres instance, OpenBao dev mode); shared = always-on dev on the free Oracle VM."
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
  })
  default = {
    postgres = "postgres:18.6-alpine@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395"
    keycloak = "quay.io/keycloak/keycloak:26.8.1@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332"
    openbao  = "quay.io/openbao/openbao:2.7.2@sha256:5046911075e137e154ce49ab051502f4ec7cf367d484ae4a4dce665d9b90561f"
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
