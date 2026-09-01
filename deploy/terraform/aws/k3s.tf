data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_ebs_volume" "postgres" {
  filter {
    name   = "volume-id"
    values = [var.postgres_volume_id]
  }
}

data "aws_subnet" "k3s" {
  id = module.vpc.public_subnets[1]
}

resource "aws_ebs_volume" "k3s_state" {
  availability_zone = data.aws_ebs_volume.postgres.availability_zone
  encrypted         = true
  size              = var.k3s_state_volume_size
  type              = "gp3"

  tags = {
    Name = "${var.aws_resource_prefix}-k3s-state"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ec2_tag" "postgres_application" {
  resource_id = var.postgres_volume_id
  key         = "Application"
  value       = var.application_tag
}

resource "aws_ec2_tag" "postgres_environment" {
  resource_id = var.postgres_volume_id
  key         = "Environment"
  value       = "production"
}

resource "aws_secretsmanager_secret" "application_kubernetes" {
  name                    = "${var.aws_resource_prefix}/kubernetes/application"
  description             = "Recoverable Kubernetes application Secret manifest; value is managed outside Terraform."
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "postgres_kubernetes" {
  name                    = "${var.aws_resource_prefix}/kubernetes/postgres"
  description             = "Recoverable Kubernetes Postgres Secret manifest; value is managed outside Terraform."
  recovery_window_in_days = 30
}

data "aws_iam_policy_document" "k3s_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "k3s" {
  name               = "${var.aws_resource_prefix}-k3s"
  assume_role_policy = data.aws_iam_policy_document.k3s_assume_role.json
}

resource "aws_iam_role_policy_attachment" "k3s_ssm" {
  role       = aws_iam_role.k3s.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "k3s_ecr" {
  role       = aws_iam_role.k3s.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

data "aws_iam_policy_document" "k3s_runtime" {
  statement {
    sid = "AttachOnlyProductionState"
    actions = [
      "ec2:AttachVolume",
    ]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*",
      data.aws_ebs_volume.postgres.arn,
      aws_ebs_volume.k3s_state.arn,
    ]
  }

  statement {
    sid = "DescribeStorage"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeVolumes",
    ]
    resources = ["*"]
  }

  statement {
    sid = "RestoreKubernetesSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      aws_secretsmanager_secret.application_kubernetes.arn,
      aws_secretsmanager_secret.postgres_kubernetes.arn,
    ]
  }
}

resource "aws_iam_role_policy" "k3s_runtime" {
  name   = "${var.aws_resource_prefix}-k3s-runtime"
  role   = aws_iam_role.k3s.id
  policy = data.aws_iam_policy_document.k3s_runtime.json
}

resource "aws_iam_instance_profile" "k3s" {
  name = "${var.aws_resource_prefix}-k3s"
  role = aws_iam_role.k3s.name
}

resource "aws_security_group" "k3s" {
  name        = "${var.aws_resource_prefix}-k3s"
  description = "Outbound-only production K3s host; operator and deployment access use SSM."
  vpc_id      = module.vpc.vpc_id

  egress {
    description = "Application and AWS API HTTPS/DNS egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_launch_template" "k3s" {
  name_prefix            = "${var.aws_resource_prefix}-k3s-"
  image_id               = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = var.k3s_instance_type
  update_default_version = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.k3s.arn
  }

  network_interfaces {
    associate_public_ip_address = true
    delete_on_termination       = true
    device_index                = 0
    security_groups             = [aws_security_group.k3s.id]
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_protocol_ipv6          = "disabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
    instance_metadata_tags      = "disabled"
  }

  monitoring {
    enabled = false
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = 30
      volume_type           = "gp3"
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${var.aws_resource_prefix}-k3s"
      Role = "k3s"
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name = "${var.aws_resource_prefix}-k3s-root"
      Role = "disposable-root"
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/k3s-user-data.sh.tftpl", {
    application_secret_arn = aws_secretsmanager_secret.application_kubernetes.arn
    aws_region             = var.aws_region
    ecr_registry           = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
    helm_archive_sha256    = var.helm_archive_sha256
    helm_version           = var.helm_version
    k3s_binary_sha256      = var.k3s_binary_sha256
    k3s_state_volume_id    = aws_ebs_volume.k3s_state.id
    k3s_version            = var.k3s_version
    kubernetes_namespace   = var.kubernetes_namespace
    postgres_secret_arn    = aws_secretsmanager_secret.postgres_kubernetes.arn
    postgres_volume_id     = var.postgres_volume_id
  }))
}

resource "aws_autoscaling_group" "k3s" {
  name                = "${var.aws_resource_prefix}-k3s"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  health_check_type   = "EC2"
  vpc_zone_identifier = [data.aws_subnet.k3s.id]

  launch_template {
    id      = aws_launch_template.k3s.id
    version = "$Latest"
  }

  tag {
    key                 = "Application"
    value               = var.application_tag
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = "production"
    propagate_at_launch = true
  }

  tag {
    key                 = "ManagedBy"
    value               = "terraform"
    propagate_at_launch = true
  }

  lifecycle {
    precondition {
      condition     = data.aws_subnet.k3s.availability_zone == data.aws_ebs_volume.postgres.availability_zone
      error_message = "The K3s subnet must be in the retained Postgres volume's availability zone."
    }
  }
}
