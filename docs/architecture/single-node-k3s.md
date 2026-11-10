# Single-node K3s production

## Decision

Production runs on one self-healing EC2 host with K3s rather than a managed Kubernetes control plane. Kubernetes stays the deployment interface: Helm charts, immutable ECR images, Deployments, Secrets, service accounts, and Helm release rollback. The host runs the K3s server, Postgres, the bot, and the worker, plus the Console when it is enabled.

This avoids a fixed control-plane charge, which would dominate the bill for a workload this small, while keeping one repository and one Terraform stack (`deploy/terraform/aws/`) for runtime, deployment, recovery, and cost.

## Shape

- One `t3a.medium` in a one-instance Auto Scaling group, in the availability zone of the database volume.
- A 30 GiB disposable root disk, never backed up.
- The retained 20 GiB encrypted Postgres volume, mounted through a static local PersistentVolume with `Retain`. The host refuses to format it if its filesystem is missing.
- An 8 GiB encrypted K3s-state volume.
- Daily backups of both volumes, retained for 14 days.
- One ECR repository and two Secrets Manager records holding the Kubernetes Secret manifests. Terraform owns the secret containers but never their values.

The target is roughly $40 per month at on-demand rates. The burstable host gives two x86 vCPUs; its 4 GiB of memory is oversubscribed by container limits, so memory pressure belongs in production observation.

## Operational responsibility

Without a managed control plane, the stack owns what a provider would:

- K3s and Helm binaries are version- and checksum-pinned in Terraform bootstrap data.
- The Auto Scaling group replaces a failed host. Bootstrap attaches both durable volumes before K3s starts.
- Upgrades change the reviewed pinned versions; routine application deployments never rebuild the host.
- Launch-template user data is limited to 16 KiB by EC2, so the server template ships gzip-compressed through `base64gzip`; a unit test keeps it under the limit.

This is a single-node deployment. A host failure causes downtime while the replacement attaches the zonal volumes and starts K3s.

## Security

- The host security group has no inbound rule. The Kubernetes API is not reachable from the internet; GitHub Actions and operators use Systems Manager.
- IMDSv2 is required with a hop limit of 1, so pods cannot reach the node identity.
- The node role may attach only the two production volumes, read only the two Kubernetes recovery secrets, pull ECR images, and register with Systems Manager.
- Every workload runs under one app service account with no Kubernetes token mounted and no permission to create Jobs or Pods or read Secrets. The deployment script verifies this on every release.
- ECR credentials are short-lived and refreshed by a host timer into one namespace-local image-pull Secret, without putting the password in process arguments or logs.

## Recovery

Recovery creates a replacement host from Terraform, attaches the two state volumes or restores them from backup, restores the Kubernetes Secrets from Secrets Manager, and runs the ordinary Helm deployment. Apply Terraform only from a clean `main` after reviewing a saved plan, as `deploy/terraform/aws/README.md` describes.

## Alternatives

- **Managed Kubernetes.** Lowest operational burden, but its fixed control-plane charge alone exceeds the cost target.
- **Amazon ECS on EC2.** No orchestration fee and a managed control plane, but a new deployment and rollback contract and different storage and operator tooling.
- **Docker Compose or systemd containers.** Operationally small, but loses Kubernetes service-account isolation and Helm rollback.
- **An external VPS.** Possibly cheaper compute, but moves the database, backups, IAM, image registry, and deployment trust at once for a small saving.

## Never change server token flags

Keep the `k3s.service` unit at exactly the flags the cluster was created with. Never add, remove, or change `--token`, `--token-file`, `--agent-token`, or `--agent-token-file` on the existing cluster. `tests/unit/architecture.test.ts` pins the server flags.

The reason is a K3s behavior with the SQLite (kine) datastore. A token flag rewrites `server/cred/passwd` on the persistent K3s-state volume. On every start, K3s compares each bootstrap file on disk with its copy in the datastore and refuses to start when they differ and the disk copy is newer; with SQLite it never writes the changed file back. The next start fails with `cred/passwd newer than datastore and could cause a cluster outage`, and replacing the host does not help, because the state volume and datastore outlive the root disk. Recovery is to back up and remove `cred/passwd`, which K3s recreates from the datastore, and restore the original flags.

Issue any new credential through the Kubernetes API rather than through server bootstrap files.
