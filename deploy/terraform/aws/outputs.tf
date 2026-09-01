output "aws_region" {
  value = var.aws_region
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "app_ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "github_actions_deploy_role_arn" {
  value = aws_iam_role.github_actions_deploy.arn
}

output "github_actions_build_role_arn" {
  value = aws_iam_role.github_actions_build.arn
}

output "postgres_backup_volume_id" {
  value = var.postgres_volume_id
}
