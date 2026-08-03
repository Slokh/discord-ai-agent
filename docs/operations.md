# Operations

This guide covers installation, configuration, process roles, indexing, observability, production debugging, deployment, and recovery.

## Requirements

- Node.js 22+
- Postgres with pgvector
- Discord application and bot token
- OpenRouter API key

GitHub credentials and a task-signing secret are optional unless code-update PRs are enabled. Privy credentials are optional unless wallets are enabled. Spotify credentials are optional and only expose Spotify tools when complete.

## Local setup

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run migrate
npm run preflight
```

Set at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OPENROUTER_API_KEY`, and `DATABASE_URL`. The example database URL uses the Compose Postgres on local port 5433.

Generate the least-privilege Discord invite:

```bash
npm run invite-url
```

For a minimal split runtime, start the bot and chat worker in separate terminals:

```bash
npm run dev
```

```bash
npm run worker
```

The bot handles gateway ingress and delivery. The worker executes queued chat requests. Start `npm run api` when using the run console or sandbox callbacks. `npm run start:all` is intended only for a fully configured built environment.

## Configuration ownership

`.env.example` and [Configuration](configuration.md) are generated from the accepted manifest in `src/config/environment.ts`. `src/config/env.ts` separates those deployment inputs from versioned `productConfig`. Environment variables are reserved for credentials, private Discord identity/policy, release metadata, the externally routed control URL, Kubernetes namespace, and the immutable sandbox image. Model choices, limits, repository target, queue topology, and payment rail change through reviewed source. Production startup rejects retired variables; run `npm run config:check` whenever the manifest changes.

Important feature gates:

| Capability | Required configuration |
| --- | --- |
| Chat | Discord token/client/guild, OpenRouter key, database |
| Code updates | GitHub PAT or App credentials, task-signing secret, worker; API for callbacks |
| Spotify | Client ID and client secret |
| Wallets, transfers, and wagers | Both Privy credentials |
| Public run console | API role, password, HTTPS/public URL when exposed |

Administrative mutations use `BOT_OWNER_USER_ID` and `OPS_ALLOWLIST_USER_IDS`. Code-update requests remain available to members when the feature is deployed.

## Indexing and memory

The gateway stores live message changes. Run an initial or repair crawl for historical coverage:

```bash
npm run crawl
npm run embeddings:backfill
```

The worker drains embedding jobs. Use `npm run reindex` only when cursors must be reset and the guild intentionally recrawled. Lexical search is available before embeddings complete.

Useful maintenance scripts include `aliases`, `blocked-users`, `embeddings:reprioritize`, and the retention/reconciliation work built into the worker. Run scripts against production only through their explicit production-aware path; do not point local experiments at the production database accidentally.

## Production-first inspection

Operator tools resolve the versioned production control-plane URL or the active Kubernetes context. They fail rather than silently falling back to localhost or a local database. Use `--api-url` for another explicit control plane and `--source db` only for intentional isolated direct-DB inspection.

```bash
npm run runs:inspect -- --list --limit 20
npm run tasks:status
npm run console:dev:live
```

The API role serves authenticated run-console routes and Prometheus metrics. Keep the service private when possible. If public, require HTTPS and `CONTROL_UI_AUTH_PASSWORD`.

The metrics surface reports runtime event latency/cost/tokens, answer status/latency/cost by model and application revision, tool outcomes, reviewed run ratings and failure modes, delivery recoveries, and code-update backlog/phase timing. These are observable outcomes rather than guesses derived from answer wording; for example, unnecessary refusals are counted only when a reviewer classifies them.

## Debug a Discord result

For a single Discord link, begin with:

```bash
npm run discord:debug -- <discord-message-link>
```

For a suspected rollout regression, audit the full channel and retained reply chains:

```bash
npm run discord:audit -- --channel <channel-id> --since-deploy --include-reply-chains
```

Investigation order:

1. Resolve the deployed revision and rollout time.
2. Confirm ingress captured the intended current message and reply chain.
3. Inspect the persisted turn envelope, memory, and operative model input.
4. Inspect selected tools, canonical arguments, typed results, and rejected gates.
5. Separate model completion from delivery intent and Discord network writes.
6. Cluster repeated failures by revision before changing code.
7. Fix the smallest canonical owner and add focused regression coverage.

Do not begin with browser scraping, provider blame, or source speculation when the runtime ledger can show what happened. Model I/O may be inspected after authorization and redaction; private chain of thought is not available or required.

## Native bug inbox

The Unicode `🐛` reaction marks a Discord message for requester-scoped debugging. `listDiscordBugMarkers` returns only markers and context the requester may see. Removing the reaction clears the marker.

The repair workflow reproduces the linked run, adds a general regression test, opens a focused PR when requested, deploys after normal review, and retries the original prompt reply after the fix is live. Never copy private marker content into Frog, a public issue, PR metadata, or tracked fixtures.

Every bug-marked execution is also captured as private negative feedback. In the run console, classify the failure and add expected/forbidden tools or required/forbidden answer text, then run:

```bash
npm run eval:regressions
```

The export stays under `.discord-ai-agent/evals/` with owner-only file permissions. Cases without an observable assertion remain skipped instead of pretending that a note is an executable test.

## Build and release verification

Before deployment:

```bash
npm run preflight:deploy
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

CI builds the console and TypeScript runtime, runs verification and DB checks, scans source and container dependencies, runs CodeQL, publishes commit-tagged images, and then triggers deployment for the verified revision. After Helm completes, deployment verifies each role's image and `APP_REVISION`, confirms the worker may create sandbox Jobs, and runs a private canary through the compiled prompt path. The canary proves a permission-scoped Discord stats call, an actual hosted web search, authenticated read access to the configured GitHub repository, sandbox-image scheduling and completion, and a real Discord send/delete cycle. A failed boundary fails the rollout instead of treating configured tool metadata as readiness. Build, migration, rollout, readiness, capability verification, and Discord delivery remain distinct stages.

## Kubernetes production

The reference deployment is the Helm chart in `deploy/helm/discord-ai-agent/`; `deploy/terraform/aws/` provides an AWS baseline for VPC, EKS, ECR, RDS, and GitHub OIDC.

Create one namespace-scoped application Secret through your secret manager with the required app variables. Prefer GitHub App credentials in production. Add Privy credentials only when payments are enabled. Pods read secret values at startup, so restart deployments after secret changes.

Install or upgrade:

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent \
  --create-namespace \
  --set image.repository="$REGISTRY/discord-ai-agent" \
  --set image.tag="$GIT_SHA" \
  --set sandbox.image="$REGISTRY/discord-ai-agent-sandbox:$GIT_SHA"
```

Inspect rollout by role:

```bash
kubectl -n discord-ai-agent get pods
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-api
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-bot
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-worker
```

The chart runs migrations as a hook; production application pods never run migrations on startup. Commit-tagged application and sandbox images are built once and promoted; the deployment workflow must not rebuild a different artifact.

## Sandbox and network posture

The worker service account may create per-task Jobs, Secrets, and ConfigMaps. The sandbox service account has no Kubernetes API access. Sandbox secrets omit Discord and database credentials. Network policy should permit the internal callback API, DNS, and required HTTPS destinations only.

Every code-update task runs in a separate Kubernetes Job. The regular worker owns queue handoff and reconciliation; no dedicated warm worker, persistent cache, or alternate execution backend exists.

## Local Kubernetes validation

Use kind or another local cluster when the Kubernetes sandbox path itself is under test:

```bash
kind create cluster --name discord-ai-agent
docker build -t discord-ai-agent:local .
kind load docker-image discord-ai-agent:local --name discord-ai-agent
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent --create-namespace \
  --set image.repository=discord-ai-agent \
  --set image.tag=local \
  --set image.pullPolicy=IfNotPresent \
  --set sandbox.image=discord-ai-agent:local \
  --set sandbox.imagePullPolicy=IfNotPresent
```

Create the application Secret first and point `DATABASE_URL` at a Postgres instance reachable from the cluster. Validate chat delivery and one harmless code-update request, then inspect the Job, callback events, PR, and cleanup. This is an advanced integration path, not the default contributor loop.

## Recovery checks

When production is unhealthy, inspect these independently:

- database connectivity and migration completion;
- bot gateway readiness and Discord permissions;
- worker queue registration and backlog age;
- agent-runtime silence/hard timeouts;
- API authentication and callback reachability;
- Kubernetes Job state;
- delivery obligations awaiting replay;
- payment or transfer reconciliation when enabled;
- deployed revision versus the revision that produced a run.

Use provider or Kubernetes logs after the canonical ledger identifies the failing boundary. A successful model result with a pending delivery obligation is a delivery incident; a missing execution after persisted ingress is a queue incident; a submitted transfer without a terminal receipt is a reconciliation incident.
