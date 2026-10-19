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

variable "public_subnet_cidrs" {
  description = "Existing public subnet CIDRs; the K3s host uses the subnet in the database availability zone."
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]
}

variable "k3s_instance_type" {
  description = "Single production host size for K3s, the application, and Postgres."
  type        = string
  default     = "t3a.medium"
}

variable "k3s_state_volume_size" {
  description = "Encrypted gp3 capacity for recoverable K3s state and Helm release history."
  type        = number
  default     = 8
}

variable "k3s_version" {
  description = "Pinned K3s release installed on the production host."
  type        = string
  default     = "v1.34.11+k3s1"
}

variable "k3s_binary_sha256" {
  description = "SHA-256 of the pinned linux-amd64 K3s binary."
  type        = string
  default     = "c1991a83985375d318560ac10f2def2fa117995d94d0319d801f283ca074d1b0"
}

variable "helm_version" {
  description = "Pinned Helm release installed on the production host."
  type        = string
  default     = "v4.2.4"
}

variable "helm_archive_sha256" {
  description = "SHA-256 of the pinned linux-amd64 Helm archive."
  type        = string
  default     = "c306b46f719b0a4da32d0f78ee21bf90ce8d602f15b22ab753f0674d1670a7f3"
}

variable "sandbox_instance_types" {
  description = "Spot instance types, in preference order, for the tainted sandbox K3s agent pool."
  type        = list(string)
  default     = ["t3a.large", "t3.large", "m6a.large", "m5a.large"]
}

variable "sandbox_root_volume_size" {
  description = "Disposable encrypted gp3 root capacity for sandbox images and task workspaces."
  type        = number
  default     = 40
}

variable "gvisor_version" {
  description = "Pinned gVisor release providing runsc and containerd-shim-runsc-v1 on sandbox nodes."
  type        = string
  default     = "20260928.0"
}

variable "gvisor_archive_sha256" {
  description = "SHA-256 of the pinned x86_64 gVisor release archive."
  type        = string
  default     = "f3ed9131bc252259df150e270154180188f9df56b73a2312940325e1f522a2d6"
}
