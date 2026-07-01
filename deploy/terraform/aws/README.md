# AWS Terraform Baseline

This directory provisions the production reference infrastructure:

- VPC with public/private subnets
- EKS cluster and managed node group
- ECR repositories for app and sandbox images
- RDS Postgres for Discord history, sessions, traces, and embeddings
- GitHub Actions OIDC deploy role

Apply from a secure operator machine:

```bash
terraform init
terraform plan \
  -var='github_repository=owner/repo' \
  -var='database_password=...'
terraform apply
```

After apply:

1. Store `github_actions_deploy_role_arn` as GitHub secret `AWS_DEPLOY_ROLE_ARN`.
2. Store these GitHub repository variables:
   - `AWS_REGION`: use the `aws_region` output.
   - `EKS_CLUSTER_NAME`: use the `cluster_name` output.
   - `ECR_REPOSITORY`: use the repository name, for example `discord-ai-agent`, not the full ECR URL.
   - optional `K8S_NAMESPACE`
   - optional `HELM_RELEASE`
   - optional `CODEGEN_WORKER_ENABLED=true` to deploy the dedicated warm codegen worker.
   - optional `SANDBOX_CACHE_ENABLED=true` to mount the shared sandbox cache PVC.
   - optional `SANDBOX_CACHE_SIZE`, for example `20Gi`.
   - optional `SANDBOX_CACHE_STORAGE_CLASS` when the default cluster storage class is not appropriate.
3. Create the Kubernetes app Secret described in `../../../docs/eks-deploy.md`.
4. Merge to `main`; CI builds images and deploys the Helm chart.

The Terraform deliberately does not store Discord/OpenRouter/GitHub App secrets. Deliver those through your normal secret manager into the Kubernetes Secret.
