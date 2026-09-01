output "aws_region" {
  value = var.aws_region
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

output "k3s_state_volume_id" {
  value = aws_ebs_volume.k3s_state.id
}

output "k3s_autoscaling_group_name" {
  value = aws_autoscaling_group.k3s.name
}

output "k3s_instance_role_arn" {
  value = aws_iam_role.k3s.arn
}
