terraform {
  required_version = ">= 1.15.0"

  # Production supplies the existing S3 backend through an operator-owned
  # backend configuration file; account-specific state metadata stays private.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = var.application_tag
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
