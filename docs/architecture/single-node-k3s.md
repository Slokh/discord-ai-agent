# Single-node K3s production

## Decision

Run the small production deployment on one self-healing EC2 host with K3s instead of a managed EKS control plane. Keep Kubernetes as the application and sandbox isolation interface. Keep the existing Helm charts, immutable ECR images, Postgres database, deployment promotion record, and content-free readiness gates.

This removes the fixed EKS cluster charge without replacing Kubernetes Jobs with a privileged Docker socket or creating a second execution model.

## Benefits

- Removes the managed control-plane charge that dominates the infrastructure bill.
- Preserves Kubernetes Deployments, Jobs, Secrets, service accounts, RBAC, and Helm release rollback.
- Keeps the Kubernetes API private; GitHub Actions and operators reach the host through AWS Systems Manager.
- Keeps the retained Postgres volume and its existing daily recovery points.
- Uses one repository and one Terraform stack for runtime, deployment, recovery, and cost ownership.

The expected steady-state infrastructure is one `m6a.large`, one public IPv4 address, a 30 GiB disposable root disk, the retained 20 GiB Postgres disk, an 8 GiB K3s-state disk, incremental backups, ECR, and two small Secrets Manager records. The target is approximately $75 per month at current on-demand rates.

## Costs and operational responsibility

EKS previously owned the highly available control plane, Kubernetes upgrades, and managed worker replacement. K3s moves those responsibilities into the application stack:

- K3s and Helm binaries are version- and checksum-pinned in Terraform bootstrap data.
- An Auto Scaling group replaces a failed EC2 host in the database availability zone.
- The host attaches the two exact durable volumes before K3s starts.
- K3s state is encrypted on its own EBS volume and backed up daily for 14 days.
- The root disk remains disposable and is never selected for backup.
- Upgrades change the reviewed pinned versions; routine application deployments do not rebuild the host.

This remains a single-workload-node deployment. A host failure causes downtime while the replacement attaches the zonal volumes and starts K3s. The former EKS deployment also had one workload node and the same zonal database constraint, although its control plane remained available during that downtime.

## Security implications

- The host security group has no inbound rule. The Kubernetes API is not internet-accessible.
- IMDSv2 is required and its hop limit prevents pod access to the node identity.
- The node role may attach only the two production state volumes, read only the two Kubernetes recovery secrets, pull ECR images, and register with Systems Manager.
- Application and sandbox service accounts keep their existing token and RBAC boundaries.
- ECR credentials are short-lived and refreshed into one namespace-local image-pull Secret without placing the password in process arguments or logs.
- The two existing Kubernetes Secrets are copied directly into Secrets Manager without exposing decoded values. Terraform owns the secret containers but never stores their values in state.
- Postgres is mounted through a static local PersistentVolume with `Retain`; the host refuses to format that volume if its filesystem is absent.

## Recovery and rollback

The cutover is staged:

1. Provision the K3s host, state disk, IAM role, recovery-secret containers, and outbound-only security group while EKS remains live.
2. Copy the two live Kubernetes Secret manifests into Secrets Manager without printing their values.
3. Verify the new instance is managed by Systems Manager and is waiting only for the still-attached Postgres disk.
4. Scale the old bot and worker to zero, then stop old Postgres.
5. Let the replacement host attach both durable disks and start K3s.
6. Install Postgres and the application with the bot initially at zero replicas; verify the database, image, revision, RBAC, and restart-free stability.
7. Start exactly one Discord bot and confirm its gateway-ready log.
8. Destroy EKS only after the K3s deployment is verified.

Before step 8, rollback stops the K3s workloads, detaches the Postgres disk, and restores the existing EKS StatefulSet and application. The database schema is unchanged by this infrastructure move. After step 8, recovery creates a replacement host from Terraform, restores the two state volumes or their backups, restores the Kubernetes Secrets from Secrets Manager, and runs the ordinary Helm deployment.

## Alternatives

### Keep EKS

This has the lowest migration risk but retains the fixed control-plane charge. A compute commitment reduces only the EC2 portion and cannot reach the cost target.

### Amazon ECS on EC2

ECS has no orchestration fee and retains a managed control plane. It requires a second execution backend for isolated repository tasks, a new deployment and rollback contract, and different storage and operator tooling. It is a reasonable future direction only if Kubernetes stops being the product's isolation interface.

### Docker Compose or systemd containers

This is operationally small but removes Kubernetes Job and service-account isolation. Reintroducing equivalent isolation through a privileged Docker socket would weaken a current security boundary. This option is rejected.

### Move to an inexpensive external VPS

This could lower compute cost further but moves the database, backups, IAM, image registry, and deployment trust at once. It expands migration and recovery risk for a smaller incremental saving. This option is deferred.

## Kill criteria

Abort the migration and restore EKS before its destruction if any of these remain unproven:

- the retained Postgres filesystem mounts without modification and the application schema is intact;
- exactly one Discord gateway client becomes ready;
- bot and worker run the intended immutable image and revision;
- the application service account remains unable to create sandbox Jobs in the current lightweight profile;
- ECR credentials refresh without persistent AWS credentials;
- a host replacement can reattach the K3s-state and Postgres volumes; or
- deployment failure can restore the prior Helm release without paid model traffic or Discord-visible smoke messages.
