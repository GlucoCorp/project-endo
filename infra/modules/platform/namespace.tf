# Namespace with Pod Security Admission "restricted" (ADR-0014) and default-deny networking.

resource "kubernetes_namespace_v1" "platform" {
  metadata {
    name = var.namespace
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
      "endo.glucorp.health/environment"    = var.profile
    }
  }
}

# Deny all traffic in and out unless a later policy allows it.
resource "kubernetes_network_policy_v1" "default_deny" {
  metadata {
    name      = "default-deny"
    namespace = kubernetes_namespace_v1.platform.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

# Every pod may resolve DNS via the cluster DNS service.
resource "kubernetes_network_policy_v1" "allow_dns" {
  metadata {
    name      = "allow-dns-egress"
    namespace = kubernetes_namespace_v1.platform.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Egress"]
    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "kube-system" }
        }
        pod_selector {
          match_labels = { "k8s-app" = "kube-dns" }
        }
      }
      ports {
        port     = "53"
        protocol = "UDP"
      }
      ports {
        port     = "53"
        protocol = "TCP"
      }
    }
  }
}

locals {
  ns = kubernetes_namespace_v1.platform.metadata[0].name

  # Shared container hardening (PSA restricted).
  hardened = {
    allow_privilege_escalation = false
    run_as_non_root            = true
    capabilities_drop          = ["ALL"]
  }
}
