# Operations

This guide covers local setup, configuration, process roles, indexing, the operator Console, production debugging, build and release, and recovery.

## Requirements

- Node.js 22.19 or later
- Postgres with pgvector
- Rust 1.97 (pinned in `rust-toolchain.toml`) to build the nanocode host
- A Discord application and bot token
- An OpenRouter API key

Privy credentials are needed only for wallets.

## Local setup

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run migrate
npm run preflight
```

Set at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OPENROUTER_API_KEY`, and `DATABASE_URL`. The example database URL uses the Compose Postgres on local port 5433.

The worker spawns `discord-agent-nanocodex-runtime` from `PATH`. Install it once, and again after changing `native/nanocodex-runtime/`:

```bash
cargo install --locked --path native/nanocodex-runtime
```

Generate the least-privilege Discord invite:

```bash
npm run invite-url
```

Start the bot and the worker in separate terminals:

```bash
npm run dev
```

```bash
npm run worker
```

The bot handles gateway ingress and delivery; the worker runs queued turns and maintenance. `npm run start:all` runs every role in one built process. Outside production, each process applies migrations at startup.

Run one prompt through the full runtime without Discord delivery with `npm run prompt`. The host keeps sessions in Postgres when `DATABASE_URL` is set; `NANOCODE_STORE=memory` keeps them in the host process instead.

## Configuration ownership

`.env.example` and [Configuration](configuration.md) are generated from the manifest in `src/config/environment.ts`; run `npm run config:check` whenever it changes. `src/config/env.ts` separates those deployment inputs from versioned `productConfig`. Environment variables hold credentials, private Discord identity and access policy, and release metadata. Models, limits, retention windows, timeouts, and the payment rail change through reviewed source. Production startup rejects retired variables.

| Capability | Required configuration |
| --- | --- |
| Chat | Discord token, client ID, and guild ID; OpenRouter key; database |
| Wallets, transfers, and wagers | Both Privy credentials |
| Hosted Console sign-in | `DISCORD_CLIENT_SECRET` and `CONSOLE_SESSION_SECRET` |

`BOT_OWNER_USER_ID` and `OPS_ALLOWLIST_USER_IDS` gate `strict_ops` tools.

## Indexing and memory

The gateway stores live message changes. Run an initial or repair crawl for historical coverage, then fill embeddings:

```bash
npm run crawl
npm run embeddings:backfill
```

The worker runs a daily reconciliation crawl. It does not consume the embedding queue; run `npm run embeddings:worker` to drain it continuously. Use `npm run reindex` only when cursors must be reset and the guild recrawled. Lexical search works without embeddings.

Other maintenance scripts include `aliases`, `blocked-users`, `embeddings:reprioritize`, and `discord-text:backfill`. Run scripts against production only through their explicit production-aware path; never point a local experiment at the production database by accident.

## Operator Console

The Console is an optional read-only role. Its Helm deployment is off by default (`console.enabled`), and the standard deployment does not enable it. When enabled it listens on port 8081, writes a heartbeat, and serves:

- `/healthz`, unauthenticated, for Kubernetes and load-balancer probes;
- `/api/overview`: environment, revision, service heartbeats, and verified deployments;
- `/api/activity`: a complete, bounded index of the last three days for the selected types — prompts and replies (`conversation`, the default), retained Discord messages, verified releases, and system jobs;
- `/api/activity/<kind>/<story-id>`: lazy detail for one story, with one chronological trace of retained Discord context, model and tool execution, typed events, and delivery.

All, Running, Waiting, Issues, and Done filter the loaded index locally. Command-K (Control-K) searches it, and arrow keys or J/K move between stories. The projection exposes only allowlisted operational metadata such as model, reasoning level, token usage, cost, tool outcome, and latency; it never exposes private reasoning, raw tool arguments, secrets, or artifact contents. It has no mutation endpoints.

In production every page and data endpoint except `/healthz` requires a signed session that `/auth/login` and `/auth/callback` create only after Discord OAuth confirms membership in the configured guild. An optional public service (`console.publicService.enabled`) puts a TLS load balancer in front of it. Local loopback runs skip authentication.

| Command | Use |
| --- | --- |
| `npm run console` | Tunnel to the deployed Console service on loopback (`http://127.0.0.1:8081`). Requires the Console to be enabled in production. |
| `npm run console:dev` | Run the branch's Console UI and projection locally against production through a read-only database relay. Requires `CONSOLE_DATABASE_URL`. |
| `npm run console:dev:ui` | Run only the branch's UI against the deployed Console API. |
| `npm run console:local` | Run the Console against the local database. |
| `npm run console:provision` | Create or rotate the read-only `CONSOLE_DATABASE_URL` login role from a trusted workstation. |
| `npm run console:health -- --revision <sha> --internal-url <url>` | Content-free health check of the overview, activity index, revision, projection freshness, and a sampled detail. |

`console:dev` forces `default_transaction_read_only=on` and a statement timeout on every connection, verifies the session is read-only before serving, and never starts migrations, heartbeats, jobs, or Discord clients. The manual `Production Observation` workflow runs `console:health` against a deployed Console, including the public boundary.

## Production-first inspection

The runtime ledger is Postgres data, not an HTTP operator API. Investigate it from a configured application pod or an explicitly selected production database; never fall back to a local default while diagnosing production.

Run a bounded command on the production host through Systems Manager:

```bash
AWS_PROFILE=production-operator scripts/runProductionCommand.sh \
  'k3s kubectl -n discord-ai-agent get pods,statefulsets,deployments -o wide'
```

`npm run release:status -- --pr <number>` combines an explicit PR (or the current non-main branch), Helm release state, role images, readiness and revisions, restart counts, and the matching deployment workflow run. It exits nonzero for failed checks, role drift, incomplete rollout, or restarted pods, and reports unavailable evidence explicitly.

## Debug a Discord result

For a Discord link or a suspected rollout regression, start from the retained ledger and correlate ingress, reply-chain, model, tool, and delivery events. Warning signals include warning- and error-level events, so a successful prompt can still be triaged when a tool or delivery step degraded.

1. Resolve the deployed revision and rollout time.
2. Confirm ingress captured the intended current message and reply chain.
3. Inspect the persisted turn envelope and the session key: a changed contract hash starts a fresh session.
4. Check whether the turn was steered (`agent.execution.steered`), fell back (`agent.nanocodex.fallback_model`), or was repaired (`agent.nanocodex.repair_started`).
5. Inspect selected tools, canonical arguments, typed results, and rejected gates.
6. Separate model completion from delivery intent and Discord network writes.
7. Cluster repeated failures by revision before changing code.
8. Fix the smallest owner and add focused regression coverage.

Do not begin with browser scraping, provider blame, or source speculation when the ledger can show what happened. Runtime diagnostics are for trusted operators, not a model-facing capability. Private chain of thought is neither available nor required.

Deleted reply parents are informational `discord.reply_context.unavailable` events. Unexpected fetch failures remain warnings.

A worker that logs `nanocode host started without its durable session store` is running sessions in memory: check `DATABASE_URL` and Postgres reachability from the worker. A turn that fails with `nanocode host exited` restarts the host on the next turn.

## Build and release verification

Before deployment:

```bash
npm run preflight:deploy
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

CI classifies changed paths and runs lint, tests, the production build, repository-policy checks, DB verification, the native-runtime job (cargo fmt, clippy, tests, build, and `tests/native` against Postgres), and infrastructure checks in parallel, each only for the paths it owns. Unknown paths take the broader path. The required `verify` job accepts skipped jobs but never a cancelled or failed one. CodeQL runs separately. The `Agent Evals` workflow runs only on PRs labeled `evals` (see [Development](development.md#evals)).

CI builds one runtime image (`final` target of the `Dockerfile`, Docker Bake group `release`), which contains the compiled application and the nanocode host binary. When candidate publishing is enabled, same-repository PRs push a `tree-<Git tree hash>` candidate after the cheaper checks pass, and a `main` push promotes the matching candidate to the commit-SHA tag instead of rebuilding; a missing candidate fails closed. Otherwise `main` builds and pushes the commit-SHA image directly.

On a deployable `main` push, CI invokes the reusable `Deploy K3s` workflow after `verify` succeeds. It sends `scripts/deployK3s.sh` to the production host through Systems Manager and checks the downloaded script's SHA-256 before running it. The script refreshes the ECR pull credential, upgrades Postgres and the application with Helm (migrations run as a pre-upgrade hook), and then checks:

- Postgres, worker, and bot rollout;
- the exact image and `APP_REVISION` on bot and worker, and their ready replica counts;
- that the worker runs as the shared `<release>-app` identity and that identity cannot create Jobs or Pods or read Secrets;
- the public-table baseline;
- a 30-second restart-free window;
- the bot's gateway-ready log line.

These checks make no model call, send no Discord message, and spend no funds. On success the worker writes the revision and rollout ID to `deployment_verifications`. On failure the script rolls back to the previous Helm revision; a failed first install leaves the bot at zero replicas. Migrations are forward-only and must keep the previous application revision working long enough for that rollback.

Run the deterministic failure suite with `npm run test:reliability`: same-thread serialization, cross-thread concurrency, Discord rate limits and idempotent delivery, model timeouts and retries, and runtime lifecycle. `npm run verify:db` additionally proves concurrent ledger writes and queued work surviving a restart.

## Kubernetes production

Production is the Helm chart in `deploy/helm/discord-ai-agent/` plus `deploy/helm/postgres/`, on the AWS stack in `deploy/terraform/aws/`. One `t3a.medium` EC2 host runs the K3s server, Postgres, the bot, and the worker (and the Console when enabled). The host has no inbound security-group rule and takes deployment and operator commands only through Systems Manager. Every workload runs under one app service account with no Kubernetes token mounted.

The 30 GiB root disk is disposable. The retained 20 GiB encrypted Postgres disk and the 8 GiB encrypted K3s-state disk are pinned to the host's availability zone and backed up daily for 14 days. The Auto Scaling group replaces a failed host, and bootstrap attaches both volumes before starting K3s. Secrets Manager keeps the two Kubernetes Secret manifests without putting their values in Terraform state. See [Single-node K3s production](architecture/single-node-k3s.md) for the decision and its constraints, and `deploy/terraform/aws/README.md` before any `terraform apply`.

Never add, remove, or change token flags on the K3s server unit; see [the lesson](architecture/single-node-k3s.md#never-change-server-token-flags). `tests/unit/architecture.test.ts` pins the server flags.

Use Helm, not `kubectl rollout undo`, for recovery so one field manager owns application revisions. Run Helm and Kubernetes commands through `scripts/runProductionCommand.sh`, and select an explicit known-good Helm revision (`npm run release:rollback -- --to <helm-revision>`); never guess a rollback target.

## Recovery checks

When production is unhealthy, inspect these independently:

- database connectivity and migration completion;
- bot gateway readiness and Discord permissions;
- worker queue registration and backlog age;
- the nanocode host: durable store, crashes, and turn timeouts;
- delivery obligations awaiting replay;
- payment reconciliation when wallets are enabled;
- the deployed revision versus the revision that produced a run.

Use provider or Kubernetes logs after the ledger identifies the failing boundary. A successful model result with a pending delivery obligation is a delivery incident; a missing execution after persisted ingress is a queue incident; a submitted transfer without a terminal receipt is a reconciliation incident.
