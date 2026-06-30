# Local Kubernetes Full Loop

This guide runs the same code-update loop as production, but against a local Kubernetes cluster. It is useful before deploying to EKS because it exercises the bot, queue, internal callback API, worker, sandbox Job, GitHub PR creation, and Discord progress edits end to end.

## Prerequisites

- Docker Desktop, kind, or k3d
- `kubectl`
- `helm`
- A reachable Postgres database with pgvector
- A Discord bot invite for your test server
- OpenRouter credentials
- GitHub credentials that can push branches and open PRs

Run the packaging preflight first:

```bash
npm run preflight:deploy
```

## Create A Local Cluster

With kind:

```bash
kind create cluster --name discord-ai-agent
kubectl create namespace discord-ai-agent
```

Build and load a local image:

```bash
docker build -t discord-ai-agent:local .
kind load docker-image discord-ai-agent:local --name discord-ai-agent
```

The sandbox can use the same image for local validation:

```bash
kind load docker-image discord-ai-agent:local --name discord-ai-agent
```

## Create The Secret

Create the app secret in the cluster. Use `host.docker.internal` for Docker Desktop Postgres, or put Postgres inside the cluster if you prefer.

```bash
kubectl -n discord-ai-agent create secret generic discord-ai-agent-env \
  --from-literal=DATABASE_URL='postgres://postgres:postgres@host.docker.internal:5432/discord_ai_agent' \
  --from-literal=DISCORD_TOKEN="$DISCORD_TOKEN" \
  --from-literal=DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" \
  --from-literal=DISCORD_GUILD_ID="$DISCORD_GUILD_ID" \
  --from-literal=OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  --from-literal=GITHUB_TOKEN="$GITHUB_TOKEN" \
  --from-literal=TASK_SIGNING_SECRET="$TASK_SIGNING_SECRET"
```

If you use a GitHub App instead of `GITHUB_TOKEN`, include `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID`.

## Install The Chart

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent \
  --set image.repository=discord-ai-agent \
  --set image.tag=local \
  --set image.pullPolicy=IfNotPresent \
  --set sandbox.image=discord-ai-agent:local \
  --set sandbox.imagePullPolicy=IfNotPresent \
  --set config.githubRepository="$GITHUB_REPOSITORY" \
  --set config.githubBaseBranch="${GITHUB_BASE_BRANCH:-main}"
```

Watch the pods:

```bash
kubectl -n discord-ai-agent get pods -w
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-bot -f
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-worker -f
```

## Test The Full Loop

In Discord:

```text
@ai deployment status
@ai update yourself to add a harmless debug log in the status tool
```

Expected behavior:

- The bot replies with a single Thinking message.
- The message edits as the task moves through sandbox startup, repo refresh/worktree, dependency cache, Codex, verify, scan, push, and PR.
- A sandbox Job appears in Kubernetes.
- A `discord-ai-agent-sandbox-cache` PVC is created by the chart and reused across sandbox Jobs.
- The final Discord edit contains the PR link or a concise failure summary, plus phase timing and cache hit/miss details.
- `@ai what happened to the last update?` shows task events and sandbox command output.
- `@ai show recent update tasks` lists recent task history.

The warm sandbox pool is off by default. To exercise the reusable-pod path locally, install the chart with:

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --set sandbox.warmPool.enabled=true \
  --set sandbox.warmPool.size=1
```

The first request may still use a cold Job while the warm Pod becomes ready. Later requests should show `warm_pool_hit` in task progress when a ready warm Pod is claimed.

Optional cache checks:

```bash
npm run sandbox-cache:status
npm run sandbox-cache:prune
```

## Cleanup

```bash
helm uninstall discord-ai-agent --namespace discord-ai-agent
kind delete cluster --name discord-ai-agent
```
