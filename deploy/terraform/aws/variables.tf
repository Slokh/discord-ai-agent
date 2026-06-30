variable "aws_region" {
  description = "AWS region for EKS, RDS, and ECR."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "discord-ai-agent"
}

variable "github_repository" {
  description = "GitHub repository allowed to deploy through OIDC, formatted owner/repo."
  type        = string
}

variable "database_username" {
  description = "RDS master username."
  type        = string
  default     = "discord_ai_agent"
}

variable "database_password" {
  description = "RDS master password. Store the final DATABASE_URL in the Kubernetes Secret."
  type        = string
  sensitive   = true
}

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "database_allocated_storage_gb" {
  description = "Initial RDS storage in GB."
  type        = number
  default     = 100
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs for EKS nodes and RDS."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs for NAT/load-balancing."
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]
}
