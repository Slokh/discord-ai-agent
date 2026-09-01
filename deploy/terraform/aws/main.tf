data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.21.0"

  # Physical names are supplied privately so adopting production state does not
  # recreate the VPC, cluster, repository, or IAM roles.
  name = var.aws_resource_prefix
  cidr = "10.0.0.0/16"

  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  private_subnets = var.private_subnet_cidrs
  public_subnets  = var.public_subnet_cidrs

  enable_nat_gateway      = false
  single_nat_gateway      = false
  enable_dns_hostnames    = true
  enable_dns_support      = true
  map_public_ip_on_launch = true

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }

  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_ecr_repository" "app" {
  name                 = var.aws_resource_prefix
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after one day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Retain the newest ten immutable revisions"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy     = local.ecr_lifecycle_policy
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "20.37.2"

  cluster_name    = var.aws_resource_prefix
  cluster_version = "1.34"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  authentication_mode                      = "API_AND_CONFIG_MAP"
  enable_cluster_creator_admin_permissions = false
  cluster_endpoint_public_access           = true
  cluster_endpoint_private_access          = true

  kms_key_administrators = ["arn:aws:iam::224638724342:root"]

  # Application events and the durable Postgres ledger own production
  # observability. Paid control-plane logs added roughly 1.2 GB every day while
  # providing no readiness signal used by this small deployment.
  cluster_enabled_log_types              = []
  cloudwatch_log_group_retention_in_days = 7

  eks_managed_node_groups = {
    default = {
      # Bot, worker, and Postgres request 600m CPU and 1.75 GiB in total. One
      # non-burstable 8 GiB node leaves ample room for Kubernetes system pods;
      # max_size=2 preserves a rolling-update slot without idle steady capacity.
      min_size     = 1
      max_size     = 2
      desired_size = 1

      node_repair_config = {
        enabled = true
      }

      # EBS volumes are zonal. Keep the sole steady-state node in the same
      # availability zone as the retained production Postgres volume.
      subnet_ids        = [module.vpc.public_subnets[1]]
      instance_types    = ["m6a.large"]
      capacity_type     = "ON_DEMAND"
      enable_monitoring = false
      block_device_mappings = {
        root = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = 30
            volume_type           = "gp3"
            encrypted             = true
            delete_on_termination = true
          }
        }
      }
    }
  }

  access_entries = {
    github_actions_deploy = {
      principal_arn = aws_iam_role.github_actions_deploy.arn

      policy_associations = {
        cluster_admin = {
          policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = {
            type = "cluster"
          }
        }
      }
    }
  }
}

resource "aws_eks_access_entry" "operator" {
  cluster_name  = module.eks.cluster_name
  principal_arn = var.operator_role_arn
}

resource "aws_eks_access_policy_association" "operator" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_eks_access_entry.operator.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy"

  access_scope {
    type       = "namespace"
    namespaces = [var.kubernetes_namespace]
  }
}

data "aws_iam_policy_document" "ebs_csi_assume_role" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name               = "${var.aws_resource_prefix}-ebs-csi-driver"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

# EBS CSI uses EKS Pod Identity; both add-ons are generic storage plumbing for
# the standalone Postgres volume and are unrelated to the retired agent stack.
resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name                = module.eks.cluster_name
  addon_name                  = "eks-pod-identity-agent"
  addon_version               = "v1.3.10-eksbuild.3"
  resolve_conflicts_on_update = "PRESERVE"
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = module.eks.cluster_name
  addon_name                  = "aws-ebs-csi-driver"
  addon_version               = "v1.63.1-eksbuild.1"
  resolve_conflicts_on_update = "PRESERVE"

  pod_identity_association {
    role_arn        = aws_iam_role.ebs_csi.arn
    service_account = "ebs-csi-controller-sa"
  }

  depends_on = [aws_eks_addon.pod_identity_agent]
}
