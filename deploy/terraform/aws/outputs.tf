output "cluster_name" {
  value = module.eks.cluster_name
}

output "aws_region" {
  value = var.aws_region
}

output "app_ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "sandbox_ecr_repository_url" {
  value = aws_ecr_repository.sandbox.repository_url
}

output "github_actions_deploy_role_arn" {
  value = aws_iam_role.github_actions_deploy.arn
}

output "database_endpoint" {
  value = aws_db_instance.postgres.address
}

output "database_name" {
  value = aws_db_instance.postgres.db_name
}
