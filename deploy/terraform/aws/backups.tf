data "aws_caller_identity" "current" {}

resource "aws_kms_key" "backups" {
  description             = "Discord AI Agent production backup encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "backups" {
  name          = "alias/${var.aws_resource_prefix}-production-backups"
  target_key_id = aws_kms_key.backups.key_id
}

resource "aws_backup_vault" "production" {
  name        = "${var.aws_resource_prefix}-production"
  kms_key_arn = aws_kms_key.backups.arn
}

data "aws_iam_policy_document" "backup_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.aws_resource_prefix}-production-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume_role.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "production" {
  name = "${var.aws_resource_prefix}-production"

  rule {
    rule_name         = "daily-postgres-ebs"
    target_vault_name = aws_backup_vault.production.name
    schedule          = "cron(0 7 ? * * *)"
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = 14
    }
  }
}

resource "aws_backup_selection" "production_ebs" {
  name         = "discord-ai-agent-postgres-ebs"
  plan_id      = aws_backup_plan.production.id
  iam_role_arn = aws_iam_role.backup.arn

  # Node root volumes are disposable and recreated by the managed node group.
  # Only the durable Postgres volume needs daily recovery points.
  resources = [
    "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/${var.postgres_volume_id}",
  ]
}
