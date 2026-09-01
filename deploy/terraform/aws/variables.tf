variable "aws_region" {
  description = "AWS region hosting the Discord AI Agent production platform."
  type        = string
  default     = "us-east-1"
}

variable "aws_resource_prefix" {
  description = "Existing physical identifier retained to adopt production without recreating resources."
  type        = string
}

variable "github_repository_subjects" {
  description = "Immutable GitHub OIDC repository identity allowed to build and deploy production."
  type        = set(string)
}

variable "operator_role_arn" {
  description = "AWS IAM Identity Center role granted namespace-scoped production access."
  type        = string
}

variable "kubernetes_namespace" {
  description = "Existing namespace containing the Discord AI Agent production workloads."
  type        = string
}

variable "postgres_volume_id" {
  description = "Existing encrypted EBS volume containing the production Postgres data directory."
  type        = string

  validation {
    condition     = can(regex("^vol-[0-9a-f]+$", var.postgres_volume_id))
    error_message = "postgres_volume_id must be an EBS volume ID."
  }
}

variable "application_tag" {
  description = "Existing application tag retained while adopting production resources."
  type        = string
}

variable "private_subnet_cidrs" {
  description = "Existing private subnet CIDRs used by the EKS control plane."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnet_cidrs" {
  description = "Existing public subnet CIDRs used by the single worker node."
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]
}
