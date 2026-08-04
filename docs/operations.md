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

The bot handles gateway ingress and delivery. The worker executes queued chat requests. Start `npm run api` only to receive signed callbacks from isolated code-update sandboxes. `npm run start:all` is intended only for a fully configured built environment.

## Configuration ownership

`.env.example` and [Configuration](configuration.md) are generated from the accepted manifest in `src/config/environment.ts`. `src/config/env.ts` separates those deployment inputs from versioned `productConfig`. Environment variables are reserved for credentials, private Discord identity/policy, release metadata, Kubernetes namespace, and the immutable sandbox image. Model choices, limits, repository target, queue topology, callback URL, and payment rail change through reviewed source. Production startup rejects retired variables; run `npm run config:check` whenever the manifest changes.

Important feature gates:

| Capability | Required configuration |
| --- | --- |
| Chat | Discord token/client/guild, OpenRouter key, database |
| Code updates | GitHub PAT or App credentials, task-signing secret, worker, and internal callback receiver |
| Spotify | Client ID and client secret |
| Wallets, transfers, and wagers | Both Privy credentials |

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

The runtime ledger is canonical Postgres data, not an HTTP operator API. Investigate it only from a trusted, configured application pod or an explicitly selected production database; never fall back to a local default while diagnosing production behavior.

`release:status` remains the deployment-health command:

```bash
npm run release:status -- --pr <number>
```

Normal-reply friction is the deliberate direct-database exception because Frog owns its configured store interface. The application wrapper resolves the existing database configuration and selects only the private `discord-ai-agent` namespace:

```bash
npm run frog:agent -- migrate
npm run frog:agent -- list
npm run frog:agent -- resolve <entry-id>
```

The wrapper maps the application's existing database URL to Frog's scoped database setting, which selects the Postgres store, and supplies the fixed private namespace. `migrate` is idempotent and normally needed only when preparing a database outside the application migration flow. For production, run commands inside a configured application pod or explicitly supply the production environment; do not let a local default masquerade as production evidence. `npx frog list` is different: it shows repository-development friction from the default file store.

The production image intentionally removes npm and npx. Use the compiled wrapper in a pod:

```bash
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/frogAgent.js list
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/frogAgent.js resolve <entry-id>
```

The API role is an internal-only signed callback receiver. It exposes only `/healthz` and task-scoped callback writes from isolated code-update sandboxes; it has no operator reads, metrics, browser UI, public service, or password configuration.

`release:status` is the single safe release view. It combines an explicitly requested PR (or the current non-main branch), Helm release state, role images/readiness/revisions, current-pod restart counts, the matching deployment workflow, and the deployed revision-quality assessment. Running it from `main` intentionally omits PR evidence without producing a warning. It uses the same typed deployment-health evaluator as CI and exits nonzero for failed checks, deployment failure, role drift, incomplete rollout, restarted current pods, stale active execution/task work, or a failed quality gate; unavailable evidence is reported explicitly rather than guessed.

The worker reconciles stale non-task executions into an explicit failed terminal result so crashed probes or lost queue workers cannot remain running forever.

## Debug a Discord result

For a Discord link or suspected rollout regression, start from the retained production ledger and correlate ingress, reply-chain, model, tool, and delivery events. Warning signals include both warning- and error-level runtime events; a top-level successful prompt can therefore still be triaged when a tool or delivery sub-operation degraded.

Investigation order:

1. Resolve the deployed revision and rollout time.
2. Confirm ingress captured the intended current message and reply chain.
3. Inspect the persisted turn envelope and memory scope.
4. Inspect selected tools, canonical arguments, typed results, and rejected gates.
5. Separate model completion from delivery intent and Discord network writes.
6. Cluster repeated failures by revision before changing code.
7. Fix the smallest canonical owner and add focused regression coverage.

Do not begin with browser scraping, provider blame, or source speculation when the runtime ledger can show what happened. Runtime diagnostics are retained for trusted operator workflows; they are not a model-facing Discord capability. Private chain of thought is not available or required.

## Native bug inbox

The Unicode `🐛` reaction marks a Discord message for requester-scoped debugging. `listDiscordBugMarkers` returns only markers and context the requester may see. Removing the reaction clears the marker.

For operator triage, use the in-Discord tool for the requester's visible markers and the trusted runtime ledger for the associated task lifecycle. The in-Discord path re-evaluates current channel visibility and must remain the source for marked-message content.

Unqualified requests such as “show my bug reports” or “fix my bugs” refer to this native inbox. GitHub/repository issue work requires explicit repository context. This distinction lives in tool contracts rather than keyword routing.

The workflow first reconstructs the linked run and performs evidence-only triage on a clean checkout. The marker is a report, not proof. Only a `confirmed_unfixed` verdict with a machine-checkable regression contract unlocks a separate repair phase; other verdicts leave source unchanged. When evidence is insufficient, the terminal result replies on the marked bot message, pings only the reporter, and identifies the context needed for a safe decision. Only a marker from the original request author can start automated triage/repair and authorize a post-deploy replay. A confirmed repair adds focused regression coverage, opens a focused PR, and deploys after normal review. Once live, the marked reply becomes a persistent `Bug fix` update and its successful posting triggers the original prompt again into a fresh reply. That contextual update does not replace the release-wide announcement; every verified revision still publishes its complete release-notes entry. Never copy private marker content into Frog, a public issue, PR metadata, or tracked fixtures.

Only a confirmed automated defect is captured as private negative feedback. Add expected/forbidden tools or required/forbidden answer text to the private regression suite, then run:

```bash
npm run eval:regressions
```

The export stays under `.discord-ai-agent/evals/` with owner-only file permissions. Cases without an observable assertion remain skipped instead of pretending that a note is an executable test.

Private regression cases carry their source application revision and failure category. The deployment workflow runs them after the capability canary, and a separate scheduled/manual workflow checks the deployed revision daily. CI logs receive only aggregate counts by source revision and category; prompts, answers, run IDs, notes, and full reports stay inside the production worker.

## Production triage

Group canonical runtime-ledger failures by deployed revision, warning/error event name, failed or empty tool result, and latency. Use retained artifacts only after authorization and redaction; do not export private prompt, reply, or member data.

Deleted reply parents are informational `discord.reply_context.unavailable` events. Unexpected fetch failures remain warnings, so warning-only triage is not polluted by normal Discord deletion.

## Build and release verification

Before deployment:

```bash
npm run preflight:deploy
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

CI classifies the changed paths and starts lint, tests, production build, repository-policy checks, and relevant DB or infrastructure verification in parallel. Documentation-only and callback-receiver-only changes do not start the DB service; application and high-consequence lifecycle changes still do. The production build performs the TypeScript compilation, so CI does not repeat a separate no-emit compilation. CodeQL remains an independent PR and scheduled analysis. On a deployable `main` push, the same CI run publishes images and invokes the reusable EKS deployment workflow after `verify` succeeds. This keeps rollout and post-deploy verification on the source commit's check graph, so a failed canary or rollback is visible as a failed main-commit check instead of a detached workflow result. Pull requests skip the deployment job. Active main runs are not cancelled by newer pushes, and the production deployment workflow remains serialized under its own non-cancelling concurrency group.

For same-repository PRs, the optional candidate-image path waits for the cheaper verification jobs to pass, then publishes runtime and codegen images to separate ECR repositories under the checked-out Git tree hash. Its OIDC role has no production-repository or Kubernetes access. Dependency, Docker, or native-manifest changes scan those exact remote images on one shared runner. After merge, CI calculates the merged tree hash, promotes only the matching candidates to commit-tagged production references, and deletes the temporary tags; a one-day lifecycle is the cleanup fallback. Candidate repositories disable redundant ECR scanning because CI scans affected candidates and the production repositories scan the promoted release. Exact-tree promotion lets main omit repeated tests and rebuilding. Once candidate publication is enabled, a missing candidate fails closed rather than rebuilding an unverified release. Before enablement, main retains the existing full verification and builds and pushes both images through one Docker Bake graph. PR builds restore trusted default-branch BuildKit caches but do not fill one-use PR cache scopes. Nested Rust targets, Terraform providers, coverage, and other local build state are excluded from the Docker context.

After Helm completes, deployment verifies each role's image and `APP_REVISION`, confirms the worker may create sandbox Jobs, and runs private canaries through the compiled prompt path. Independent GitHub, sandbox-callback, stats, bounded-randomness, and hosted-web probes run concurrently in isolated identities; exact two-turn conversation continuity remains sequential by design. The web canary supplies its typed operation as an object, matching the application-tool boundary rather than asking the model to reinterpret serialized JSON. The canary also performs non-mutating Discord bot-identity and channel-access probes. It never posts a canary message, because deleting one still leaves member clients with stale unread-channel markers. The callback canary never clones, edits, pushes, or opens a PR.

Each post-deploy stage—immediate health, capability canary, private regressions, the 30-second stability window, and durable promotion—gets one bounded retry with a short delay. The workflow records typed stage/attempt outcomes; a failed private-regression command also retains its aggregate-only safe summary, never prompt or reply content. If a stage still fails, it rolls back to the exact Helm revision captured before the upgrade and verifies that prior revision with the same restart-free health gate. A failed rollback remains a distinct terminal outcome and never hides the original failed stage. First-time installs have no rollback target and fail explicitly. Migrations remain forward-only and must preserve the preceding application revision long enough for this recovery path.

The bot does not retry bug reports or publish a deployment announcement merely because a new pod became ready. Release pods wait for the workflow to write the verified revision and unique rollout ID to Postgres after every gate passes; only then do those member-visible actions run. The rollout ID prevents a repeated deployment of the same commit from reusing an older approval. A rejected candidate therefore cannot announce itself or retry an original prompt before rollback. Local, non-SHA revisions bypass this production-only promotion gate.

Each capability attempt uses a fresh session, and one isolated retry absorbs ordinary model-call variance without retrying a tool inside an attempt. Retrieval passes only with exactly one successful stats result; randomness passes only with exactly one successful `drawRandom` completion and no runtime error event; web passes only with exactly one successful non-empty result plus provider-recorded hosted execution. Completion markers alone are insufficient evidence. A persistently failed boundary fails the rollout instead of treating configured tool metadata as readiness. After all canaries and private regressions, the typed deployment-health gate requires API, bot, and worker to remain aligned, fully ready, generation-current, and restart-free for 30 seconds. Build, migration, rollout, readiness, capability verification, and Discord delivery remain distinct stages. Durable delivery behavior is exercised by the reliability and database suites, while production observation reports failures and pending delivery obligations from real traffic without generating synthetic member-visible messages.

The production-observation workflow samples the deployed revision every six hours and retains a 48-hour aggregate containing answer status/latency by model, terminal per-run capability outcomes, raw tool attempts, recovered validation retries, warning/error counts, and delivery states. Only explicitly member-originated Discord executions enter this quality cohort; CLI prompts, evals, and deployment canaries remain observable but do not count as member answers or baselines. Pending delivery obligations become incidents after five minutes, avoiding false alerts for replies actively being delivered, while abandoned obligations fail immediately. The workflow reads the canonical runtime ledger inside the cluster and publishes only safe counts—never prompts, replies, member identities, or private Discord content. Use `npm run quality:revision -- --revision <sha> --hours 48` for the same safe operator view inside a configured runtime.

Repeated attempts of the same capability in one execution count once toward terminal capability health, using the final result; attempts and recovered schema retries remain separate efficiency signals. This prevents a recovered malformed call from masquerading as several independent member-facing failures without hiding its latency and cost. The observation compares the deployed revision with the most recently active prior revision. Hard delivery/error evidence fails immediately; rate and latency thresholds enforce only after a useful sample. A failed scheduled run is the operator alert. `rollback_candidate` means the current revision failed while its sufficiently sampled baseline passed; it is evidence to inspect and roll back, not permission for an unrelated mutation. A revision with no member answers reports `awaiting_traffic`. After traffic begins but before ten member answers it reports `insufficient_data`; the assessment includes remaining answer and tool-call sample counts. Both remain observable without generating a false incident.

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

The app and sandbox service accounts disable automatic Kubernetes token mounts; only the trusted worker receives the launcher identity. Sandbox callback bearer tokens are scoped to the task and sandbox-run IDs and expire after two hours. Each task receives a separately derived callback-signing key rather than the deployment master secret; each exact body also carries a two-minute timestamped HMAC, limiting cross-task forgery and replay while allowing normal clock skew. Terminal callbacks remain idempotent. Generic HTTPS egress excludes loopback, link-local/cloud-metadata, carrier-grade NAT, and RFC1918 ranges; the internal API is allowed separately by pod identity. On Cilium clusters, enable the FQDN policy to narrow public HTTPS to the reviewed host list.

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
