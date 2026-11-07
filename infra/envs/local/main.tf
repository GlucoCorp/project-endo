# Local development environment on k3d (ADR-0014). SYNTHETIC DATA ONLY.
#   k3d cluster create --config infra/k3d/endo-local.yaml
#   tofu -chdir=infra/envs/local init && tofu -chdir=infra/envs/local apply
# State stays on this machine (git-ignored): it contains generated dev credentials.

terraform {
  required_version = ">= 1.13.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "3.4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = "k3d-endo-local"
}

module "platform" {
  source  = "../../modules/platform"
  profile = "local"
}

output "platform" {
  value = module.platform
}
