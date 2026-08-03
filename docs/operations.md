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
npm run runs:inspect -- --list --channel <channel-id> --revision <sha> --since <ISO> --triage
npm run tasks:status
npm run console:dev:live
npm run release:status -- --pr <number>
```

List filters for kind, status, channel, revision, and start time are applied by the control plane before the result limit. This keeps older matching failures visible even when unrelated recent executions are numerous.

The API role serves authenticated run-console routes and Prometheus metrics. Keep the service private when possible. If public, require HTTPS and `CONTROL_UI_AUTH_PASSWORD`.

`release:status` is the single safe release view. It combines the current PR and checks, Helm release state, role images/readiness/revisions, current-pod restart counts, the matching deployment workflow, and the deployed revision-quality assessment. It uses the same typed deployment-health evaluator as CI and exits nonzero for failed checks, deployment failure, role drift, incomplete rollout, restarted current pods, or a failed quality gate; unavailable evidence is reported explicitly rather than guessed.

Production configuration rejects a non-HTTPS public console URL and a public URL without a password. Browsers use standard Basic authentication and scripts use a bearer header. Credentials in cookies, `?auth=`, or `?token=` query strings are not accepted, so proxies, browser history, Discord embeds, and access logs do not capture them.

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

The audit reader uses bounded concurrency and honors Discord rate-limit retries. Warning signals include both warning- and error-level runtime events; a top-level successful prompt can therefore still be triaged when a tool or delivery sub-operation degraded.

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

Unqualified requests such as “show my bug reports” or “fix my bugs” refer to this native inbox. GitHub/repository issue work requires explicit repository context. This distinction lives in tool contracts rather than keyword routing.

The repair workflow reproduces the linked run, adds a general regression test, opens a focused PR when requested, and deploys after normal review. Once live, the marked reply becomes a persistent `Bug fix` update and its successful posting triggers the original prompt again into a fresh reply; that revision is not duplicated in the release-notes channel. Never copy private marker content into Frog, a public issue, PR metadata, or tracked fixtures.

Every bug-marked execution is also captured as private negative feedback. In the run console, classify the failure and add expected/forbidden tools or required/forbidden answer text, then run:

```bash
npm run eval:regressions
```

The export stays under `.discord-ai-agent/evals/` with owner-only file permissions. Cases without an observable assertion remain skipped instead of pretending that a note is an executable test.

Private regression cases carry their source application revision and failure category. The deployment workflow runs them after the capability canary, and a separate scheduled/manual workflow checks the deployed revision daily. CI logs receive only aggregate counts by source revision and category; prompts, answers, run IDs, notes, and full reports stay inside the production worker.

## Production triage

Use `npm run runs:triage -- --since <ISO timestamp>` to group canonical runtime-ledger failures, warning/error event names, failed or empty tool results, and the slowest successful runs. Add `--revision <sha>`, `--channel <id>`, `--warnings-only`, or `--json` as needed. The report contains run IDs and signal taxonomy, not private prompt text; inspect a selected run separately for retained evidence.

Deleted reply parents are informational `discord.reply_context.unavailable` events. Unexpected fetch failures remain warnings, so warning-only triage is not polluted by normal Discord deletion.

## Build and release verification

Before deployment:

```bash
npm run preflight:deploy
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

CI builds the console and TypeScript runtime, runs verification and parallel schema-isolated DB checks, scans source and container dependencies, runs CodeQL, publishes commit-tagged images, and then triggers deployment for the verified revision. Docker BuildKit caches npm downloads and NanoCodex Cargo registries, git sources, and release artifacts across unchanged layers. Nested Rust targets, Terraform providers, coverage, and other local build state are excluded from the Docker context.

After Helm completes, deployment verifies each role's image and `APP_REVISION`, confirms the worker may create sandbox Jobs, and runs private canaries through the compiled prompt path. Separate isolated conversations prove a permission-scoped Discord stats call, one bounded repeat-until randomness call, an actual hosted web operation, and exact two-turn conversation continuity. The web canary supplies its typed operation as an object, matching the application-tool boundary rather than asking the model to reinterpret serialized JSON. The canary also verifies authenticated GitHub access, runs a sandbox pod that sends an authenticated signed no-change callback through the real internal API, and performs non-mutating Discord bot-identity and channel-access probes. It never posts a canary message, because deleting one still leaves member clients with stale unread-channel markers. The callback canary never clones, edits, pushes, or opens a PR.

Each capability attempt uses a fresh session, and one isolated retry absorbs ordinary model-call variance without retrying a tool inside an attempt. Retrieval passes only with exactly one successful stats result; randomness passes only with exactly one successful `drawRandom` completion and no runtime error event; web passes only with exactly one successful non-empty result plus provider-recorded hosted execution. Completion markers alone are insufficient evidence. A persistently failed boundary fails the rollout instead of treating configured tool metadata as readiness. After all canaries and private regressions, the typed deployment-health gate requires API, bot, and worker to remain aligned, fully ready, generation-current, and restart-free for 30 seconds. Build, migration, rollout, readiness, capability verification, and Discord delivery remain distinct stages. Durable delivery behavior is exercised by the reliability and database suites, while production observation reports failures and pending delivery obligations from real traffic without generating synthetic member-visible messages.

The production-observation workflow samples the deployed revision every six hours and retains a 48-hour aggregate containing answer status/latency by model, typed tool outcomes, warning/error counts, and delivery states. Only explicitly member-originated Discord executions enter this quality cohort; CLI prompts, evals, and deployment canaries remain observable but do not count as member answers or baselines. Pending delivery obligations become incidents after five minutes, avoiding false alerts for replies actively being delivered, while abandoned obligations fail immediately. The workflow reads the canonical runtime ledger inside the cluster and publishes only safe counts—never prompts, replies, member identities, or private Discord content. The run console also groups loaded executions by `appRevision`; use `npm run quality:revision -- --revision <sha> --hours 48` for the same safe operator view inside a configured runtime.

The observation compares the deployed revision with the most recently active prior revision. Hard delivery/error evidence fails immediately; rate and latency thresholds enforce only after a useful sample. A failed scheduled run is the operator alert. `rollback_candidate` means the current revision failed while its sufficiently sampled baseline passed; it is evidence to inspect and roll back, not permission for unattended database or release mutation. An under-sampled revision reports `insufficient_data` and remains observable without generating a false incident.

Run the deterministic failure suite with `npm run test:reliability`. It covers same-thread serialization, cross-thread concurrency, Discord rate limits and idempotent final delivery, model timeouts/retries, durable queue handoff, signed sandbox callbacks, and lost-sandbox reconciliation. `npm run verify:db` additionally proves concurrent ledger writes and queued work surviving a producer/worker restart.

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

Use Helm—not `kubectl rollout undo`—for production recovery so one field manager continues to own application revisions. Inspect `helm history`, choose the known-good Helm revision, and run:

```bash
npm run release:rollback -- --to <helm-revision>
```

The recovery command reads the target revision's immutable application SHA, performs a waiting Helm rollback with job cleanup and conflict reclamation, then applies the same 30-second restart-free deployment-health gate used by CI. It requires an explicitly selected Helm revision and never guesses a rollback target.

## Sandbox and network posture

The worker service account may create per-task Jobs, Secrets, and ConfigMaps. The sandbox service account has no Kubernetes API access. Sandbox secrets omit Discord and database credentials. Network policy should permit the internal callback API, DNS, and required HTTPS destinations only.

The app and sandbox service accounts disable automatic Kubernetes token mounts; only the trusted worker receives the launcher identity. Sandbox callback bearer tokens are scoped to the task and sandbox-run IDs and expire after two hours. Each exact callback body also carries a two-minute timestamped HMAC, limiting replay while allowing normal clock skew. Terminal callbacks remain idempotent. Generic HTTPS egress excludes loopback, link-local/cloud-metadata, carrier-grade NAT, and RFC1918 ranges; the internal API is allowed separately by pod identity. On Cilium clusters, enable the FQDN policy to narrow public HTTPS to the reviewed host list.

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
