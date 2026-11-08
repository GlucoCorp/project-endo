output "namespace" {
  value = local.ns
}

output "postgres_instances" {
  description = "Instance name -> databases it hosts."
  value       = local.pg_instances
}

output "secrets" {
  description = "Kubernetes Secrets holding generated credentials (values never printed)."
  value = {
    db_owner_urls      = { for db, s in kubernetes_secret_v1.db_owner_url : db => s.metadata[0].name }
    audit_api_url      = kubernetes_secret_v1.audit_api_url.metadata[0].name
    keycloak_admin     = kubernetes_secret_v1.keycloak.metadata[0].name
    openbao_root_token = kubernetes_secret_v1.openbao.metadata[0].name
  }
}
