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

The expected steady-state infrastructure is one `t3a.medium`, one public IPv4 address, a 30 GiB disposable root disk, the retained 20 GiB Postgres disk, an 8 GiB K3s-state disk, incremental backups, ECR, and two small Secrets Manager records. The target is approximately $40 per month at current on-demand rates. The burstable host preserves two x86 vCPUs while matching the observed low sustained CPU load; its 4 GiB memory is intentionally oversubscribed by container limits, so memory pressure and sandbox failures must remain part of production observation.

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

## Addendum: dedicated sandbox node pool

### Decision

Untrusted code no longer runs on the production host. Code-update sandboxes already ran `npm install` of arbitrary dependencies. The computer profile now downloads and runs member-supplied programs, including Windows executables under Wine. Every sandbox Job therefore runs on a separate tainted spot K3s agent under gVisor, behind a credential-injecting egress proxy, with deny-by-default sandbox NetworkPolicy. The server host keeps Postgres, the bot, the worker, the callback API, and the proxy. This is still one control plane and one Terraform stack; it adds a second, disposable workload node that holds no state.

### Shape

- `<prefix>-k3s-sandbox` Auto Scaling group: spot only, minimum 0, maximum 1, desired 0, across both public subnets, with price-capacity-optimized allocation over several x86 instance types. It uses the same pinned AL2023 image and K3s binary as the server, adds the pinned gVisor release, and uses a K3s `config-v3.toml.tmpl` that registers the `runsc` containerd runtime with a cgroup driver matching runc.
- Agents join with `discord-ai-agent.dev/pool=sandbox` and taint `discord-ai-agent.dev/sandbox=true:NoSchedule`. The chart's `gvisor` RuntimeClass carries that selector and toleration, and a ValidatingAdmissionPolicy rejects sandbox pods that do not use it.
- Own IAM role: Systems Manager registration, pull from the sandbox ECR repository, and read of the agent join record. It has no volume, application-secret, or other ECR repository access.
- Own security group: egress to the server on 6443/tcp, 8472/udp, and 10250/tcp, plus HTTPS for node bootstrap and AWS APIs. Ingress is flannel VXLAN from the server only, because server-originated overlay packets are new UDP flows. The server security group gains the matching three ingress rules from the sandbox group.
- Join credential: a K3s bootstrap token from `k3s token create --ttl 24h --usages authentication --description sandbox-agent`. It is a kubeadm-style `<id>.<secret>` credential stored as the `bootstrap-token-<id>` Secret in `kube-system`, and it is published in secure format, `K10<SHA-256 of the cluster CA>::<id>.<secret>`. K3s v1.34.11+k3s1 admits the `system:bootstrappers` group only to the agent supervisor endpoints; server join needs the `k3s:server` role, so this token cannot join a server. The server's `discord-ai-agent-agent-join-refresh` timer mints a token one minute after boot and every six hours. It writes `{server_url, token}` (the private API URL) to the `<prefix>/k3s/agent-join` Secrets Manager secret, then deletes every other `sandbox-agent` token, and the K3s token cleaner removes any that expire. Minting goes through the Kubernetes API and never touches server bootstrap files or `k3s.service`. A resource policy denies `GetSecretValue` to every principal except the sandbox role. A K3s agent presents its token on every start, so agents re-read and shape-check the record before each `k3s-agent` start.
- Scale-on-demand: the server's `discord-ai-agent-sandbox-scaler` service runs one pass every 20 seconds. A pass counts unfinished sandbox Jobs and non-terminal sandbox pods (`app.kubernetes.io/name=discord-ai-agent,app.kubernetes.io/component=sandbox`, all namespaces) and reads the group's desired capacity. With demand at desired 0, it sets desired to 1 with `--no-honor-cooldown`. After ten continuous idle minutes at desired 1, it sets desired to 0. Demand clears the idle window, so a pending or running sandbox pod always holds the agent. The idle timestamp lives in `/var/lib/discord-ai-agent/sandbox-idle-since` on the disposable root disk, not the K3s state volume; a host replacement only restarts the window. The capacity change is the last step of a pass, after every Kubernetes and AWS read has succeeded and parsed as a count. Otherwise the pass exits and the loop logs the failure. The unit is ordered after `k3s.service` but neither requires nor starts it. The server role gains `autoscaling:SetDesiredCapacity` on the sandbox group's ARN only, plus `autoscaling:DescribeAutoScalingGroups`, which cannot be resource-scoped. The group keeps `ignore_changes = [desired_capacity]`, so Terraform never reverts the scaler.
- Stale Node cleanup: nothing deregisters an agent on scale-in or spot interruption, so its Node stays `NotReady`. Its `<hostname>.node-password.k3s` Secret also stays and would make K3s reject a later instance that reused the hostname. The server's `discord-ai-agent-sandbox-node-cleanup` timer runs every five minutes. It deletes the Node and that Secret only for a `discord-ai-agent.dev/pool=sandbox` Node, never `discord-ai-agent-production` or a control-plane node, that has been `NotReady` for more than ten minutes and whose private IP no live EC2 instance holds. An instance at that IP counts as live only if it launched before the Node registered; a newer one has reused the address. Any AWS, Kubernetes, or timestamp error aborts the run before it deletes anything. The unit is `Requisite=k3s.service`, so a run never starts a stopped server. It uses the server role's existing `ec2:DescribeInstances` grant, which cannot be resource-scoped, and adds no IAM permission. An agent-side shutdown hook was rejected: spot interruption and hard termination do not reliably run it, and the agent's node credential cannot delete `kube-system` Secrets.
- Second ECR repository `<prefix>-sandbox` for the sandbox image, which CI tags and promotes with the runtime image.

### Costs and responsibilities

At zero desired capacity the pool costs nothing beyond the extra ECR storage. A running agent is billed at spot rates, with its 40 GiB gp3 root, only while it exists. Under scale-on-demand that is each burst of sandbox work plus a cold start of a few minutes and a ten-minute idle tail, and never more than one agent. The first task after an idle period waits in `Pending` through that cold start (spot launch, bootstrap downloads, K3s join, sandbox image pull), which counts against its 30-minute Job deadline. Tasks within ten minutes of each other share the warm agent. Spot capacity shortfalls delay the start but do not change the contract. Demand-driven scaling is the only scaler; a cluster autoscaler or launcher-driven scale-up was not needed for one tainted pool with a maximum of one. Spot interruption ends a running sandbox and surfaces as `sandbox_disappeared`.

gVisor and K3s versions are pinned with SHA-256 checksums in Terraform, like K3s and Helm on the server. gVisor ships only a release archive, so the archive is pinned and its full layout is installed: `runsc`, `containerd-shim-runsc-v1`, and the `gvisor-bin/` sidecars (including `gvisor_sentry`) that `runsc` requires next to itself.

### Security implications

- A gVisor escape lands on a disposable node whose kubelet, under NodeRestriction, sees only the Secrets of pods scheduled to it. That is the per-task sandbox Secret and the namespace image-pull Secret, which can pull only non-secret images.
- Sandboxes never hold the real OpenRouter key or GitHub token. Only the server-side proxy does, and it injects them only into verified TLS to the matching hosts. Repository-profile pods (`credentialed` label) get OpenRouter and GitHub on port 8080. Computer-profile pods (`model` label) get only OpenRouter on port 8082, preferably a separate spend-capped `SANDBOX_OPENROUTER_API_KEY`, because the untrusted program in that pod can spend it for the task's lifetime.
- IMDSv2 with a hop limit of 1 and the NetworkPolicy deny of `169.254.0.0/16` both keep pods away from node identity.
- DNS to kube-dns remains available to sandboxes and is the remaining unfiltered channel.

### Rollout

Join changes ship in launch-template user data. They take effect when an instance launches from the new template version, or, on the running server, through the idempotent installer `scripts/installK3sSandboxServerUnits.sh`, which installs the join refresher, the stale Node cleanup, and the sandbox scaler. Until a bootstrap-token record exists, agents keep retrying their join and never fall back to another credential. Sandbox Jobs fail closed at admission until the launcher sets `runtimeClassName: gvisor`. Without a running agent they stay `Pending`; neither case runs untrusted code on the server.

Apply template changes as a targeted, reviewed plan of only the two launch templates and the server's runtime policy (see [Operations](../operations.md#sandbox-agent-join)). Both Auto Scaling groups follow `$Latest` and have no instance refresh, so applying a template replaces nothing. The fixed user data is picked up only by the next launch, including Auto Scaling self-healing.

### Lesson: never change server token flags on an existing cluster

On 2026-10-20 (UTC) the server was replaced to adopt `--agent-token-file`. The first start with the new flag succeeded and rewrote the `node` entry in `/var/lib/rancher/k3s/server/cred/passwd`. That file lives on the persistent K3s-state volume, next to a SQLite datastore that was then 48 days old. On every start, K3s v1.34 compares each bootstrap file on disk with the copy in the datastore and refuses to start when they differ and the disk copy is newer. With SQLite (kine) it never overwrites an existing bootstrap key, so the rewritten file never reached the datastore. Every later start failed with `cred/passwd newer than datastore and could cause a cluster outage`, and production was down for about six minutes. Recovery on the live host backed up and removed `cred/passwd`, which K3s recreated from the datastore. It then restored the original `k3s.service` flags and disabled the boot-time publisher.

- Keep the server unit at exactly the flags the cluster was created with. Never add, remove, or change `--token`, `--token-file`, `--agent-token`, or `--agent-token-file` on an existing cluster. Replacing the host does not undo such a change, because the state volume and datastore outlive the root disk. `tests/unit/architecture.test.ts` pins the server flags.
- Issue new credentials through the Kubernetes API (bootstrap tokens) rather than through server bootstrap files.
- The static agent password from the incident never reached the datastore. The recovered `cred/passwd` restored the original `node` entry, so that password no longer authenticates. Without an agent token, K3s writes `K10…::node:<server password>` to `/var/lib/rancher/k3s/server/agent-token`, so that file must never be published again. If the retired publisher ran after the recovery restart, an earlier `agent-join` secret version may contain it. Only the sandbox role may read the secret, and no agent has joined yet. Before the first agent joins, compare the secret's version dates with the recovery time; if a version postdates the recovery, plan a server-token rotation as its own reviewed change.
