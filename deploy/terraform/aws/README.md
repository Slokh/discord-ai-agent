# Production AWS platform

This directory is the sole infrastructure definition for the production
Discord AI Agent. It adopts the existing encrypted remote state and physical
resource names without recreating the database, VPC, EKS cluster, ECR
repository, or IAM roles.

The production workload is deliberately small:

- one `m6a.large` worker node, with a second slot available only during managed
  updates;
- one 30 GiB disposable node root volume;
- the retained 20 GiB encrypted Postgres volume;
- daily backups of only Postgres, retained for 14 days;
- no paid EKS control-plane logs or EC2 detailed monitoring;
- one immutable ECR repository retaining ten release revisions; and
- GitHub OIDC trust for only `Slokh/discord-ai-agent`.

The physical state bucket, EKS cluster, namespace, ECR repository, IAM role,
backup vault, KMS alias, and Postgres PVC names retain their existing private
identifiers. Renaming them would recreate or move live state and provides no
security or operational benefit. Those names do not imply a second application.

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
