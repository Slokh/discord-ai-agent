# AWS Terraform Baseline

This directory provisions the production reference infrastructure:

- VPC with public/private subnets
- EKS cluster and managed node group
- ECR repositories for production and short-lived candidate images
- RDS Postgres for Discord history, sessions, traces, and embeddings
- Separate GitHub Actions OIDC roles for candidate publication and production deployment

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
2. Store `github_actions_candidate_role_arn` as GitHub secret `AWS_CANDIDATE_ROLE_ARN`.
   CI calls the candidate workflow pinned to `main`; its role can publish only to tree-addressed candidate repositories and has no EKS or production-repository access.
3. Store these GitHub repository variables:
   - `AWS_REGION`: use the `aws_region` output.
   - `EKS_CLUSTER_NAME`: use the `cluster_name` output.
   - `ECR_REPOSITORY`: use the repository name, for example `discord-ai-agent`, not the full ECR URL.
   - `CANDIDATE_IMAGE_PUBLISHING_ENABLED`: set to `true` after the candidate role and repositories exist.
   - optional `K8S_NAMESPACE`
   - optional `HELM_RELEASE`
4. Create the Kubernetes app Secret described in [`../../../docs/operations.md`](../../../docs/operations.md#kubernetes-production).
5. Merge to `main`; CI promotes the exact PR-tested images when available, otherwise builds them before deployment.

The Terraform deliberately does not store Discord/OpenRouter/GitHub App secrets. Deliver those through your normal secret manager into the Kubernetes Secret.
