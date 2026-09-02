# Production AWS platform

This directory is the sole infrastructure definition for the production
Discord AI Agent. It adopts the existing encrypted remote state and physical
resource names without recreating the database, VPC, ECR repository, or GitHub
OIDC roles.

The production workload is deliberately small:

- one `m6a.large` K3s host in a one-instance Auto Scaling group;
- one 30 GiB disposable node root volume;
- the retained 20 GiB encrypted Postgres volume;
- one 8 GiB encrypted K3s-state volume;
- daily backups of Postgres and K3s state, retained for 14 days;
- no managed Kubernetes control plane or EC2 detailed monitoring;
- one immutable ECR repository retaining three release revisions; and
- GitHub OIDC trust for only `Slokh/discord-ai-agent`.

The physical state bucket, namespace, ECR repository, IAM role, backup vault,
KMS alias, and Postgres volume/PVC names retain their existing identifiers.
Renaming them would recreate or move live state and provides no operational
benefit. Those names do not imply a second application.

The host has no inbound security-group rule. Deployment and operator commands
use Systems Manager. Its role can attach only the exact Postgres and K3s-state
volumes, restore the two Kubernetes Secret manifests, and pull ECR images.
Terraform owns the Secrets Manager containers but never their values.

Apply only from a clean `main` revision after reviewing an exact saved plan:

```bash
eval "$(aws configure export-credentials --profile <operator-profile> --format env)"
terraform init -backend-config=/secure/path/production.backend.hcl
terraform plan -var-file=/secure/path/production.tfvars -out=production.tfplan
terraform show production.tfplan
terraform apply production.tfplan
```

The state bucket is a bootstrap resource and is intentionally not owned by the
stack whose state it contains. Discord, OpenRouter, GitHub App, Privy, and
database credentials remain outside Terraform in the production Kubernetes
Secret.
