# Production AWS platform

This directory is the sole infrastructure definition for the production
Discord AI Agent. It adopts the existing encrypted remote state and physical
resource names without recreating the database, VPC, ECR repository, or GitHub
OIDC roles.

The production workload is deliberately small:

- one `t3a.medium` K3s host in a one-instance Auto Scaling group;
- one 30 GiB disposable node root volume;
- the retained 20 GiB encrypted Postgres volume;
- one 8 GiB encrypted K3s-state volume;
- daily backups of Postgres and K3s state, retained for 14 days;
- no managed Kubernetes control plane or EC2 detailed monitoring;
- one immutable ECR repository retaining the current release and one rollback release; and
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

## Removing the sandbox pool

This revision deletes the tainted spot sandbox agent pool and everything that
served it. The K3s server runs in a one-instance Auto Scaling group on launch
template `$Latest` with no instance refresh, and its K3s state and Postgres
live on separate EBS volumes. Applying therefore replaces nothing: the new
server user data, without the sandbox scaler, stale sandbox Node cleanup, and
agent join token refresher, takes effect only on the next server launch
(including Auto Scaling self-healing). Until then the running host keeps those
units. Never change the `k3s.service` flags as part of this; this change does
not touch them.

1. Stop the sandbox units on the running host, so the scaler cannot raise the
   pool during the apply, and confirm the `<prefix>-k3s-sandbox` group is at
   desired capacity 0 with no instance:

   ```bash
   AWS_PROFILE=production-operator scripts/runProductionCommand.sh \
     'systemctl disable --now discord-ai-agent-sandbox-scaler.service discord-ai-agent-agent-join-refresh.timer discord-ai-agent-sandbox-node-cleanup.timer'
   ```

2. Delete every image in the `<prefix>-sandbox` ECR repository.
   `aws_ecr_repository.sandbox` has no `force_delete`, so its deletion fails
   while the repository still holds images. Repeat until `list-images` returns
   an empty list:

   ```bash
   aws ecr list-images --repository-name <prefix>-sandbox --query 'imageIds' --output json >sandbox-images.json
   aws ecr batch-delete-image --repository-name <prefix>-sandbox --image-ids file://sandbox-images.json
   ```

3. Remove `sandbox_instance_types`, `sandbox_root_volume_size`,
   `gvisor_version`, and `gvisor_archive_sha256` from the production tfvars
   file if it sets them.

4. Run `terraform plan` with `-out` and review it before any `terraform apply`.
   It must destroy only these sandbox resources:

   - `aws_autoscaling_group.k3s_sandbox`
   - `aws_launch_template.k3s_sandbox`
   - `aws_iam_role.k3s_sandbox`, `aws_iam_role_policy.k3s_sandbox_runtime`,
     `aws_iam_role_policy_attachment.k3s_sandbox_ssm`, and
     `aws_iam_instance_profile.k3s_sandbox`
   - `aws_security_group.k3s_sandbox`,
     `aws_vpc_security_group_egress_rule.k3s_sandbox_api`,
     `aws_vpc_security_group_egress_rule.k3s_sandbox_vxlan`,
     `aws_vpc_security_group_egress_rule.k3s_sandbox_kubelet`,
     `aws_vpc_security_group_egress_rule.k3s_sandbox_https`, and
     `aws_vpc_security_group_ingress_rule.k3s_sandbox_vxlan`
   - `aws_secretsmanager_secret.k3s_agent_join` and
     `aws_secretsmanager_secret_policy.k3s_agent_join` (the secret is
     scheduled for deletion after its 7-day recovery window)
   - `aws_ecr_repository.sandbox` and `aws_ecr_lifecycle_policy.sandbox`

   It must otherwise only update in place:

   - `aws_launch_template.k3s`: new `user_data`, which bumps the latest and
     default version;
   - `aws_security_group.k3s`: drops the three ingress rules from the sandbox
     group (6443/tcp, 8472/udp, 10250/tcp);
   - `aws_iam_role_policy.k3s_runtime`: drops the `PublishAgentJoin`,
     `ScaleSandboxPool`, and `DescribeSandboxPool` statements; and
   - `aws_iam_role_policy.github_actions_build` and
     `aws_iam_role_policy.github_actions_deploy`: drop the sandbox repository
     ARN.

   Reject a plan that creates or replaces anything, or touches
   `aws_autoscaling_group.k3s`, the EBS volumes, backups, the VPC, or the
   application ECR repository.

5. After the apply, delete any leftover sandbox Node and its node-password
   Secret; both live in the persistent K3s state and survive a server
   replacement. The server Node has no `pool=sandbox` label. Remaining
   `sandbox-agent` bootstrap tokens expire within 24 hours.

   ```bash
   AWS_PROFILE=production-operator scripts/runProductionCommand.sh \
     'for n in $(k3s kubectl get nodes -l discord-ai-agent.dev/pool=sandbox -o name); do k3s kubectl delete "$n"; k3s kubectl -n kube-system delete secret "${n#node/}.node-password.k3s" --ignore-not-found; done'
   ```
