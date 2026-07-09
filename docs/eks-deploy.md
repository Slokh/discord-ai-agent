# EKS Deployment

Discord AI Agent’s production reference target is AWS EKS with Postgres/pgvector and Kubernetes sandbox Jobs for code-update tasks.

A Terraform baseline for VPC, EKS, ECR, RDS, and the GitHub Actions deploy role lives in `deploy/terraform/aws`. You can also bring your own Kubernetes/Postgres setup and install only the Helm chart.

## Production Shape

```text
Discord
  -> bot Deployment
  -> Postgres / pgvector
  -> worker Deployment
  -> Kubernetes sandbox Job
  -> internal api Service
  -> GitHub PR
```

Services:

- `api`: internal sandbox callback API.
- `bot`: Discord gateway and reply delivery.
- `worker`: crawl, embeddings, queues, and sandbox Job creation.
- `sandbox`: short-lived Kubernetes Jobs created per code-update task.

## Required Secret

Create one Kubernetes Secret before installing the chart:

```bash
kubectl create namespace discord-ai-agent

kubectl -n discord-ai-agent create secret generic discord-ai-agent-env \
  --from-literal=DATABASE_URL='postgres://...' \
  --from-literal=DISCORD_TOKEN='...' \
  --from-literal=DISCORD_CLIENT_ID='...' \
  --from-literal=DISCORD_GUILD_ID='...' \
  --from-literal=OPENROUTER_API_KEY='...' \
  --from-literal=SPOTIFY_CLIENT_ID='...' \
  --from-literal=SPOTIFY_CLIENT_SECRET='...' \
  --from-literal=GITHUB_APP_ID='...' \
  --from-literal=GITHUB_APP_PRIVATE_KEY='...' \
  --from-literal=GITHUB_APP_INSTALLATION_ID='...' \
  --from-literal=TASK_SIGNING_SECRET="$(openssl rand -hex 32)" \
  --from-literal=CONTROL_UI_AUTH_PASSWORD="$(openssl rand -base64 32)"
```

For production, prefer creating the Secret from your normal secret manager rather than shell literals.
For local/dev you can use `GITHUB_TOKEN` instead of the GitHub App fields.

## Build Images

Build and push the app image:

```bash
docker build -t "$REGISTRY/discord-ai-agent:$GIT_SHA" .
docker push "$REGISTRY/discord-ai-agent:$GIT_SHA"
```

The same runtime image can be used as the sandbox image because it includes the compiled sandbox runner, coding harness CLIs, GitHub CLI, git, and ripgrep. You may publish a separate sandbox tag if you want different hardening or tooling:

```bash
docker tag "$REGISTRY/discord-ai-agent:$GIT_SHA" "$REGISTRY/discord-ai-agent-sandbox:$GIT_SHA"
docker push "$REGISTRY/discord-ai-agent-sandbox:$GIT_SHA"
```

## Install With Helm

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent \
  --create-namespace \
  --set image.repository="$REGISTRY/discord-ai-agent" \
  --set image.tag="$GIT_SHA" \
  --set sandbox.image="$REGISTRY/discord-ai-agent-sandbox:$GIT_SHA" \
  --set config.githubRepository="owner/repo"
```

Check rollout:

```bash
kubectl -n discord-ai-agent get pods
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-api
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-bot
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-worker
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-codegen-worker
```

## Sandbox Permissions

The chart creates:

- One app service account for `api`, `bot`, and migrations.
- One worker service account with sandbox-launcher RBAC, shared by the regular worker and optional dedicated codegen worker.
- One sandbox service account for task Jobs.
- A Role allowing only the worker service account to create sandbox Jobs, Secrets, and ConfigMaps.
- No RBAC permissions for the sandbox service account.

The sandbox receives only:

- `GITHUB_TOKEN`
- `OPENROUTER_API_KEY`
- `AGENT_TASK_TOKEN`
- task metadata/config

It does not receive Discord credentials or the database URL.

The worker reconciles active sandbox runs. If a Kubernetes Job fails, disappears, or completes without a terminal callback, the task is marked failed. Once a task is terminal, the worker deletes the per-task Job, Secret, and ConfigMap and records cleanup in Postgres.

For lower-latency code-update work, enable the dedicated warm codegen worker:

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --set codegenWorker.enabled=true \
  --set sandbox.cache.enabled=true
```

For GitHub Actions deploys, set repository variables instead:

- `CODEGEN_WORKER_ENABLED=true`
- `SANDBOX_CACHE_ENABLED=true`
- optional `CODEGEN_WORKER_REPLICAS`
- optional `CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS`
- optional `CODEGEN_LEASE_ACQUIRE_POLL_SECONDS`
- optional `CODEGEN_LEASE_HEARTBEAT_SECONDS`
- optional `CODEGEN_LEASE_STALE_SECONDS`
- optional `SANDBOX_CACHE_SIZE`
- optional `SANDBOX_CACHE_STORAGE_CLASS`

Daily budget limits can also be overridden with repository variables. Leave
them unset to keep the application defaults (50 turns, 10 images, 1
code-update task per user; $10/day guild spend); use `-1` to disable a limit:

- optional `BUDGET_USER_TURNS_PER_DAY`
- optional `BUDGET_USER_IMAGES_PER_DAY`
- optional `BUDGET_USER_CODEGEN_PER_DAY`
- optional `BUDGET_GUILD_DAILY_USD`

That deployment consumes only `agent.task`, uses the `local-process` backend, registers a lease in Postgres, and keeps repo, dependency, and harness caches warm on the mounted sandbox cache volume. The regular worker automatically stops consuming code-update task jobs while continuing crawl, embedding, and Discord request work.

The default warm lease settings heartbeat every 15 seconds, mark stale leases after 120 seconds, poll every 5 seconds while waiting, and wait up to 30 minutes for the warm slot. For hobby deployments where queued code updates should fail faster instead of sitting behind a wedged worker, lower `CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS`.

## Sandbox Cache

The Helm chart creates a sandbox cache PVC by default. Sandbox Jobs mount it at `/var/cache/discord-ai-agent` and reuse:

- a bare Git mirror refreshed from origin before each task
- the npm download cache
- a `node_modules` snapshot keyed by Node version plus `package.json` and `package-lock.json`

Per-task Git worktrees are created on sandbox-local temporary storage and cleaned up after each run; the shared cache is intentionally retained. If the coding harness changes `package.json` or `package-lock.json`, the sandbox refreshes dependencies again before verification so tests do not run against stale dependencies.

The default chart uses a `ReadWriteOnce` cache PVC and `worker.replicas=1`. Keep that shape unless your storage class supports the access mode and scheduling behavior you need for concurrent code-update tasks. For multi-worker or warm-pool deployments, move cache/sandbox ownership to an explicit lease model before scaling codegen horizontally.

Cache operator scripts can run anywhere the cache volume is mounted:

```bash
npm run sandbox-cache:status
npm run sandbox-cache:prune
npm run sandbox-cache:clear
```

The API `/metrics` endpoint includes active agent task backlog age, aggregate codegen phase timings, and sandbox cache hit/miss counters.

## Networking

The chart includes a baseline NetworkPolicy for sandbox pods:

- allow callback egress to the internal API service
- allow DNS
- optionally allow outbound HTTPS for GitHub, OpenRouter, npm, and package downloads

For stricter production egress, install Cilium and enable the chart's FQDN policy:

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent \
  --set networkPolicy.allowSandboxInternetEgress=false \
  --set ciliumFqdnPolicy.enabled=true
```

The default allowed hosts cover GitHub, OpenRouter, and npm package downloads. Add more hosts only for tools the sandbox actually needs.

## Public Task Viewer

The code-update task viewer redirects from `/tasks` to the run console on the API service. Keep the default cluster-internal service for the lowest-cost setup, then open it with:

```bash
kubectl -n discord-ai-agent port-forward svc/discord-ai-agent-api 8080:8080
```

If you expose it with a public hostname, use HTTPS and keep `CONTROL_UI_AUTH_PASSWORD` set. Browser login uses username `admin` and the configured password.

For an AWS LoadBalancer service with ACM TLS termination, set:

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent \
  --set api.publicService.enabled=true \
  --set api.publicService.type=LoadBalancer \
  --set-string 'api.publicService.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-ssl-cert=arn:aws:acm:REGION:ACCOUNT:certificate/CERT_ID' \
  --set-string 'api.publicService.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-ssl-ports=https' \
  --set-string 'api.publicService.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-backend-protocol=http'
```

Then create a Route53 alias or CNAME for the LoadBalancer hostname.

## Debugging

Ask the bot:

```text
@ai diagnose the last failure
@ai why did that update fail?
```

The diagnostics tool reads persisted trace events, agent task runtime events, and tool audit logs. It does not need direct access to cloud-provider logs for normal task debugging.

The API service also exposes Prometheus text metrics at `/metrics`. The Helm chart adds scrape annotations by default:

- indexed messages
- stored embeddings
- logged tool calls
- agent task counts by status
- active agent task backlog counts and oldest age by backend/status
- sandbox run counts by status

## First Run

1. Install the chart.
2. Confirm the bot logs into Discord.
3. Run an initial crawl from the worker process:

```bash
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/crawl.js
```

4. Ask in Discord:

```text
@ai hello
@ai status
@ai update yourself to add a harmless test log line
```

The update request should edit the same Discord message with progress, start a sandbox Job, and end with a GitHub PR link or a clear failure reason.
