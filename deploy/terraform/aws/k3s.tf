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

# The server writes a 24-hour K3s bootstrap token and its private API URL here
# every six hours. The token cannot join a server, and only sandbox nodes may
# read it.
resource "aws_secretsmanager_secret" "k3s_agent_join" {
  name                    = "${var.aws_resource_prefix}/k3s/agent-join"
  description             = "K3s agent-only join token and server URL; written by the server, read only by sandbox nodes."
  recovery_window_in_days = 7
}

data "aws_iam_policy_document" "k3s_agent_join" {
  statement {
    sid       = "ReadOnlyBySandboxNodes"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.k3s_sandbox.arn]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "k3s_agent_join" {
  secret_arn = aws_secretsmanager_secret.k3s_agent_join.arn
  policy     = data.aws_iam_policy_document.k3s_agent_join.json
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

  # DescribeInstances also lets the stale sandbox Node cleanup confirm that an
  # agent's instance is gone. Describe actions do not support resource scoping.
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

  statement {
    sid = "PublishAgentJoin"
    actions = [
      "secretsmanager:PutSecretValue",
    ]
    resources = [aws_secretsmanager_secret.k3s_agent_join.arn]
  }

  # The sandbox scaler may change only the sandbox pool's desired capacity.
  statement {
    sid       = "ScaleSandboxPool"
    actions   = ["autoscaling:SetDesiredCapacity"]
    resources = [aws_autoscaling_group.k3s_sandbox.arn]
  }

  statement {
    sid       = "DescribeSandboxPool"
    actions   = ["autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
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

  # Sandbox agents are the only inbound peers; the description above predates
  # them and is kept because changing it would replace the group.
  ingress {
    description     = "K3s API from sandbox agents"
    from_port       = 6443
    to_port         = 6443
    protocol        = "tcp"
    security_groups = [aws_security_group.k3s_sandbox.id]
  }

  ingress {
    description     = "Flannel VXLAN from sandbox agents"
    from_port       = 8472
    to_port         = 8472
    protocol        = "udp"
    security_groups = [aws_security_group.k3s_sandbox.id]
  }

  ingress {
    description     = "Kubelet from sandbox agents"
    from_port       = 10250
    to_port         = 10250
    protocol        = "tcp"
    security_groups = [aws_security_group.k3s_sandbox.id]
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

  # EC2 caps raw user data at 16 KiB and the server script outgrew it, so it
  # ships gzip-compressed; cloud-init on AL2023 decompresses it before running.
  user_data = base64gzip(templatefile("${path.module}/templates/k3s-user-data.sh.tftpl", {
    agent_join_secret_arn  = aws_secretsmanager_secret.k3s_agent_join.arn
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
    # The sandbox scaler reads this; the group ignores desired_capacity drift.
    sandbox_autoscaling_group = aws_autoscaling_group.k3s_sandbox.name
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

# Tainted spot K3s agents for untrusted sandbox Jobs. The pool scales to zero;
# it never runs Postgres, the bot, the worker, or the egress proxy, and its
# role cannot read application secrets or attach production volumes.
resource "aws_iam_role" "k3s_sandbox" {
  name               = "${var.aws_resource_prefix}-k3s-sandbox"
  assume_role_policy = data.aws_iam_policy_document.k3s_assume_role.json
}

resource "aws_iam_role_policy_attachment" "k3s_sandbox_ssm" {
  role       = aws_iam_role.k3s_sandbox.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "k3s_sandbox_runtime" {
  statement {
    sid = "PullSandboxImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.sandbox.arn]
  }

  statement {
    sid       = "AuthenticateToEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadAgentJoin"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.k3s_agent_join.arn]
  }
}

resource "aws_iam_role_policy" "k3s_sandbox_runtime" {
  name   = "${var.aws_resource_prefix}-k3s-sandbox-runtime"
  role   = aws_iam_role.k3s_sandbox.id
  policy = data.aws_iam_policy_document.k3s_sandbox_runtime.json
}

resource "aws_iam_instance_profile" "k3s_sandbox" {
  name = "${var.aws_resource_prefix}-k3s-sandbox"
  role = aws_iam_role.k3s_sandbox.name
}

resource "aws_security_group" "k3s_sandbox" {
  name        = "${var.aws_resource_prefix}-k3s-sandbox"
  description = "Tainted K3s sandbox agents; overlay return traffic from the server only."
  vpc_id      = module.vpc.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "k3s_sandbox_api" {
  security_group_id            = aws_security_group.k3s_sandbox.id
  description                  = "K3s API on the server"
  ip_protocol                  = "tcp"
  from_port                    = 6443
  to_port                      = 6443
  referenced_security_group_id = aws_security_group.k3s.id
}

resource "aws_vpc_security_group_egress_rule" "k3s_sandbox_vxlan" {
  security_group_id            = aws_security_group.k3s_sandbox.id
  description                  = "Flannel VXLAN to the server"
  ip_protocol                  = "udp"
  from_port                    = 8472
  to_port                      = 8472
  referenced_security_group_id = aws_security_group.k3s.id
}

resource "aws_vpc_security_group_egress_rule" "k3s_sandbox_kubelet" {
  security_group_id            = aws_security_group.k3s_sandbox.id
  description                  = "Kubelet on the server"
  ip_protocol                  = "tcp"
  from_port                    = 10250
  to_port                      = 10250
  referenced_security_group_id = aws_security_group.k3s.id
}

# Node bootstrap only: AWS APIs (SSM, ECR, Secrets Manager), pinned K3s and
# gVisor downloads, and image layers. Sandbox pods cannot use this path because
# NetworkPolicy confines them to the egress proxy on the server.
resource "aws_vpc_security_group_egress_rule" "k3s_sandbox_https" {
  security_group_id = aws_security_group.k3s_sandbox.id
  description       = "Node bootstrap and AWS API HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# VXLAN packets the server originates toward sandbox pods (for example proxy
# and callback responses) are new UDP flows, not replies to agent traffic.
resource "aws_vpc_security_group_ingress_rule" "k3s_sandbox_vxlan" {
  security_group_id            = aws_security_group.k3s_sandbox.id
  description                  = "Flannel VXLAN from the server"
  ip_protocol                  = "udp"
  from_port                    = 8472
  to_port                      = 8472
  referenced_security_group_id = aws_security_group.k3s.id
}

resource "aws_launch_template" "k3s_sandbox" {
  name_prefix            = "${var.aws_resource_prefix}-k3s-sandbox-"
  image_id               = data.aws_ssm_parameter.al2023_ami.value
  update_default_version = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.k3s_sandbox.arn
  }

  network_interfaces {
    associate_public_ip_address = true
    delete_on_termination       = true
    device_index                = 0
    security_groups             = [aws_security_group.k3s_sandbox.id]
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
      volume_size           = var.sandbox_root_volume_size
      volume_type           = "gp3"
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${var.aws_resource_prefix}-k3s-sandbox"
      Role = "k3s-sandbox"
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name = "${var.aws_resource_prefix}-k3s-sandbox-root"
      Role = "disposable-root"
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/k3s-sandbox-agent-user-data.sh.tftpl", {
    agent_join_secret_arn = aws_secretsmanager_secret.k3s_agent_join.arn
    aws_region            = var.aws_region
    gvisor_archive_sha256 = var.gvisor_archive_sha256
    gvisor_version        = var.gvisor_version
    k3s_binary_sha256     = var.k3s_binary_sha256
    k3s_version           = var.k3s_version
  }))
}

resource "aws_autoscaling_group" "k3s_sandbox" {
  name                = "${var.aws_resource_prefix}-k3s-sandbox"
  min_size            = 0
  max_size            = 1
  desired_capacity    = 0
  capacity_rebalance  = true
  health_check_type   = "EC2"
  vpc_zone_identifier = module.vpc.public_subnets

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "price-capacity-optimized"
    }

    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.k3s_sandbox.id
        version            = "$Latest"
      }

      dynamic "override" {
        for_each = var.sandbox_instance_types
        content {
          instance_type = override.value
        }
      }
    }
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
    # The server's sandbox scaler moves the pool between zero and one;
    # Terraform must not undo it.
    ignore_changes = [desired_capacity]
  }
}
