# Discord AI Agent

A self-hosted AI agent for private Discord servers.

Mention `@ai` and the bot can answer questions, search server history with Discord permissions, summarize channels, generate images, look things up on the web, remember private server skills, and open code-update PRs for itself.

The interface is intentionally simple: users talk to the bot naturally, and the model chooses tools.

## Why This Exists

Most Discord bots make people learn commands. Most AI chat apps do not understand your Discord server. Discord AI Agent is the middle path:

- One interface: `@ai <request>`
- Permission-aware memory over indexed Discord history
- Persistent per-channel conversation context
- Web, image, stats, summary, and skill tools
- Self-hosted data and deployment
- Sandboxed code-update PRs the bot opens against its own repo

The project is built for friend groups, clubs, small communities, and teams that want a useful shared assistant without sending their server history to a hosted bot.

## Architecture

```text
Discord mention
  -> bot/control plane
  -> model chooses tools
  -> Postgres memory, Discord tools, web tools, image tools
  -> durable agent task when code changes are requested
  -> sandboxed code-update run (local process by default, Kubernetes Job optional)
  -> GitHub PR
  -> Discord reply edited with progress/final result
```

The app has three roles, runnable as one process (`all`) or split across services:

- `bot`: Discord gateway process and user-facing responses. Chat and memory work with this role alone.
- `worker`: crawling, embeddings, queue processing, code-update task execution, reconciliation, and cleanup. Needed for history indexing and code-update PRs.
- `api`: internal callback API for sandbox task progress and the run console. Needed for code-update PRs and debugging UI.

Postgres with `pgvector` is the source of truth for Discord history, embeddings, skills, traces, the `agent_runtime_*` execution ledger, task projections, and sandbox runs.

## Capabilities

- Natural `@ai <request>` interaction
- Full-server crawl through the Discord bot API
- Incremental indexing for new, edited, and deleted messages
- Permission-aware history retrieval
- Per-channel persistent conversation memory
- Channel/user stats and data analysis tools
- Thread/channel summaries
- Image generation
- OpenRouter-hosted web search, web fetch, and datetime tools
- Public Spotify catalog search, item lookup, playlist/album track-list, artist discography, playlist stats, and playlist comparison tools when Spotify client credentials are configured
- Optional automatic Privy wallets, managed USD transfers, and provably fair wager settlement on Tempo
- Private DB-backed skills
- Code-update PRs through sandboxed agent tasks
- Structured logs and trace/agent-runtime event inspection

## Requirements

- Node.js 22+
- Docker Desktop or another Postgres instance with `pgvector`
- Discord application/bot token
- OpenRouter API key

Optional, for code-update PRs:

- A GitHub repository the bot can push to
- A fine-grained GitHub token (or GitHub App credentials)

That is the whole stack. Docker Compose plus `npm run dev` is the supported deployment for a private server with friends; Kubernetes is an optional advanced isolation mode (see [Advanced deployment](#advanced-deployment)).

## Quickstart

```bash
git clone https://github.com/your-org/discord-ai-agent.git
cd discord-ai-agent
npm install
cp .env.example .env
```

Start local Postgres and migrate:

```bash
docker compose up -d postgres
npm run migrate
```

Fill in `.env`:

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OPENROUTER_API_KEY=
```

`DATABASE_URL` already defaults to the Docker Compose Postgres, so you can leave it alone; set it if your Postgres runs elsewhere. To enable code-update PRs, also set `GITHUB_REPOSITORY`, `GITHUB_TOKEN` (a fine-grained PAT limited to that repo), and `TASK_SIGNING_SECRET` — the bot politely refuses code-update requests until all three are configured.

Generate an invite URL:

```bash
npm run invite-url
```

The generated member-level invite includes Create Expressions so the bot can upload custom server emoji when an authorized operator asks it to.

Invite the bot, then run:

```bash
npm run preflight
npm run dev
```

`npm run dev` starts the `bot` role, which covers chat and conversation memory. Run `npm run worker` (history indexing, code-update tasks) and `npm run api` (task callbacks, run console) in separate terminals when you need those features, or set `DISCORD_AI_AGENT_PROCESS_ROLE=all` to run everything in one process.

Try:

```text
@ai hello
@ai tools
@ai status
```

## Indexing Discord History

The bot can answer normal questions immediately. To search old Discord messages, run:

```bash
npm run crawl
npm run worker
```

Messages become keyword-searchable as soon as they are stored. Semantic search improves as embeddings finish.

Useful commands:

```bash
npm run crawl
npm run reindex
npm run embeddings:backfill
npm run embeddings:worker
npm run prompt -- --no-memory "what can you do?"
npm run eval -- --dry-run
```

`npm run prompt` constructs the same configured wallet service as the Discord runtime, so wallet-enabled local prompts exercise real balance and transfer paths rather than advertising unavailable tools.

Use [docs/evals.md](docs/evals.md) to run regression prompts before and after retrieval, tool, prompt, or codegen changes. Use [docs/tool-design.md](docs/tool-design.md) when changing model-facing tools.

## Code Updates

When someone asks `@ai update yourself to ...`, the bot creates a durable `agent.task` and the worker runs it in a sandboxed runner — a local child process by default (`CODEGEN_EXECUTION_BACKEND=local-process`), or an isolated Kubernetes Job when you opt into the advanced backend. The runner:

1. Refreshes a cached bare clone of the configured GitHub repo.
2. Creates a per-task worktree and branch.
3. Restores dependencies from a package manifest/lockfile-keyed cache, or seeds that cache with `npm ci`.
4. Runs the configured coding harness, OpenCode by default or Codex when selected, with the requested change.
5. Refreshes dependencies again if the coding harness changed `package.json` or `package-lock.json`.
6. Runs verification and release scanning.
7. Pushes an `agent/`-prefixed branch. Pushes to the base branch or protected branches (`main`, `master`, `develop`, `production`, `release*`, `hotfix/*`) are refused.
8. Opens a GitHub PR only if there is a real diff. The PR body ends with a `Prompted by:` line attributing the Discord user who asked.
9. Reports progress, cache hit/miss data, and phase timings back to the internal API.

The original Discord reply is edited with progress and the final PR link plus compact timing/cache details.
If a sandbox crashes, disappears, or exits without sending its terminal callback, the worker reconciler marks the task failed in Postgres (and, on the Kubernetes backend, later cleans up the sandbox Job, Secret, and ConfigMap).

If `GITHUB_REPOSITORY`, a GitHub credential, or `TASK_SIGNING_SECRET` is missing, the bot replies that code updates are not configured and lists exactly which variables are missing instead of failing mid-task.

The sandbox also installs ephemeral helper CLIs on the coding harness `PATH`:

- `agent-task-context` prints the task/repo/cache context.
- `agent-cache-info` prints cache entry counts from inside the sandbox.
- `agent-progress <step> <message>` sends an explicit task progress event.

Cache operator scripts:

```bash
npm run sandbox-cache:status
npm run sandbox-cache:prune
npm run sandbox-cache:clear
```

For the durable agent runtime, code-update task ledger, and sandbox lease model, see [docs/agent-runtime.md](docs/agent-runtime.md).
For a concise coding-agent map of the repo, see [docs/architecture.md](docs/architecture.md).
For source ownership maps used by coding agents, start with [src/README.md](src/README.md) and the nearest folder README.
For the current improvement roadmap, see [docs/improvement-plan.md](docs/improvement-plan.md).
For the post-hardening engineering targets and active foundation work, see [docs/continuation-plan.md](docs/continuation-plan.md).

## Advanced Deployment

Everything above runs with Docker Compose and `npm run dev`. Kubernetes is an optional isolation mode for code-update tasks and multi-service production deployments — useful if you want each code-update task in its own Job with a dedicated service account, or you already operate a cluster.

- Set `CODEGEN_EXECUTION_BACKEND=kubernetes-job` to run each code-update task in an isolated Kubernetes Job.
- For a local Kubernetes full-loop test, see [docs/local-kubernetes.md](docs/local-kubernetes.md).
- For an AWS EKS production setup with Helm, see [docs/eks-deploy.md](docs/eks-deploy.md).
- For a reference AWS infrastructure baseline, see [deploy/terraform/aws](deploy/terraform/aws).

## Configuration

Required:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application/client ID |
| `DISCORD_GUILD_ID` | Discord server to run in |
| `OPENROUTER_API_KEY` | Chat, embeddings, images, and hosted tools |
| `DATABASE_URL` | Postgres connection string (defaults to the Docker Compose Postgres) |

Required only for code-update PRs (the feature stays disabled with a clear message until all are set):

| Variable | Purpose |
| --- | --- |
| `GITHUB_REPOSITORY` | Repo for code-update PRs |
| `GITHUB_TOKEN` | Fine-grained PAT limited to `GITHUB_REPOSITORY`, or use the GitHub App variables below |
| `TASK_SIGNING_SECRET` | Signs sandbox callback tokens |

Common optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_NAME` | `ai` | Display/default mention name in prompts/docs |
| `OPENROUTER_CHAT_MODEL` | `z-ai/glm-5.2` | Main agent model |
| `OPENROUTER_CODEGEN_MODEL` | `z-ai/glm-5.2` | Coding harness model for sandboxed PR generation |
| `OPENROUTER_EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | Embedding model |
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | Image model |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | unset | Optional Spotify client-credentials integration for public catalog and high-level playlist/album/artist tools |
| `WALLET_ENABLED` | `false` | Opt into the shared Privy bot-wallet runtime. See [docs/wallets.md](docs/wallets.md). |
| `USER_WALLETS_ENABLED` | `false` | Separately opt into automatic Discord user wallets, initial grants, balance tools, transfers, and wallet-backed wagers. |
| `WALLET_BALANCES_PUBLIC` | `false` | Allow every server member to list the member-to-wallet balance directory; owner/ops can always inspect it. |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | unset | Required when the wallet runtime is enabled. Never exposed to Discord or sandbox tasks. |
| `TEMPO_NETWORK` / `TEMPO_USD_TOKEN` | `moderato` / `USDC.e` | Tempo network and six-decimal USD wallet token. Validate on Moderato before mainnet cutover. |
| `WALLET_INITIAL_GRANT_USD` / `WALLET_MAX_GAME_SETTLEMENT_USD` | `1.00` / `10.00` | Automatic first-interaction game balance and maximum reserved payout per wager. |
| `GITHUB_BASE_BRANCH` | `main` | PR base branch |
| `GITHUB_APP_ID` | unset | Preferred production GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | unset | Preferred production GitHub App private key |
| `GITHUB_APP_INSTALLATION_ID` | unset | Preferred production GitHub App installation ID |
| `CODEGEN_EXECUTION_BACKEND` | `local-process` | `local-process` runs code-update tasks in a warm worker child process; `kubernetes-job` runs each task in an isolated Kubernetes Job (advanced) |
| `CODEGEN_HARNESS` | `opencode` | Coding harness for code-update tasks: `opencode` by default, or `codex` to run tasks through Codex |
| `WORKER_CRAWL_ENABLED` / `WORKER_EMBEDDING_ENABLED` / `WORKER_TASK_ENABLED` / `WORKER_DISCORD_AGENT_ENABLED` | `true` | Split worker queues across deployments; Helm uses these for the optional dedicated code-update worker |
| `RETENTION_EVENTS_DAYS` | `60` | Worker-side age cutoff for trace, process-run, agent-runtime, and sandbox command event cleanup; `0` disables event retention cleanup |
| `RETENTION_AUDIT_DAYS` | `90` | Worker-side age cutoff for `tool_audit_logs`; `0` disables audit cleanup |
| `RETENTION_EMBEDDING_RUNS_DAYS` | `14` | Worker-side age cutoff for terminal embedding `process_runs` and cascading artifacts/events; `0` disables embedding-run cleanup |
| `RETENTION_RUNTIME_DAYS` | `90` | Age cutoff for terminal agent-runtime sessions and their executions, messages, events, and artifacts; `0` disables cleanup |
| `MEMORY_COMPACTION_THRESHOLD` | `100` | Raw `conversation_messages` per thread key before worker compaction runs; `0` disables compaction |
| `MEMORY_COMPACTION_KEEP_RECENT` | `30` | Recent raw conversation messages to keep when older rows are summarized into `conversation_snapshots` |
| `SANDBOX_CACHE_DIR` | `/var/cache/discord-ai-agent` | Sandbox repo/npm/dependency cache path (both codegen backends) |
| `SANDBOX_TASK_TIMEOUT_SECONDS` | `1800` | Max wall-clock seconds for one code-update task |
| `SANDBOX_IMAGE` | `discord-ai-agent-sandbox:latest` | Sandbox image (Kubernetes backend only) |
| `SANDBOX_CACHE_PVC_NAME` | unset | Optional PVC mounted at `SANDBOX_CACHE_DIR` (Kubernetes backend only) |
| `CONTROL_UI_AUTH_PASSWORD` | unset | Password for the authenticated run-console UI served by the `api` role |
| `CONTROL_UI_PUBLIC_URL` | unset | Public console origin, for example `https://tasks.example.com`; when set, Discord replies include a trace footer and code-update progress messages include a run-console link |
| `RELEASE_NOTES_CHANNEL_ID` | unset | Discord channel where the bot posts short, AI-written patch notes after a successful deployment |
| `PREVIOUS_APP_REVISION` | unset | Previously running commit used as the release-note diff base; the EKS workflow sets this automatically |
| `CONTROL_PLANE_INTERNAL_URL` | `http://discord-ai-agent-api:8080` | Sandbox callback URL |
| `DISCORD_AGENT_RESPONSE_TIMEOUT_MS` | `1800000` | Max time a Discord request can run before returning an error; code-update PR work continues through background task rendering |
| `AGENT_PROMPT_MAX_CONCURRENCY` | `4` | Parallel prompt capacity across distinct thread keys; prompts sharing a Discord thread remain serialized |
| `CHAT_SILENCE_TIMEOUT_MS` / `CHAT_HARD_TIMEOUT_MS` | `120000` / `600000` | Chat-only per-execution silence and hard wall-clock timeouts; code-update task timeouts remain controlled by sandbox settings |
| `BUDGET_USER_TURNS_PER_DAY` / `BUDGET_USER_IMAGES_PER_DAY` / `BUDGET_USER_CODEGEN_PER_DAY` | `50` / `10` / `1` | Per-user daily limits; set to `-1` for unlimited. Chat turn and guild-spend checks happen at Discord ingress before model calls; image/codegen limits are enforced before those expensive tools run. The owner (or ops allowlist) can override the chat-turn limit for a specific user at runtime by asking the bot, e.g. `@ai limit @user to 5 posts per day` (the `setUserTurnLimit` tool; stored in `user_budget_overrides`) |
| `BUDGET_GUILD_DAILY_USD` | `10` | Per-guild daily cap over `tool_audit_logs.estimated_cost_usd`; set to `-1` for unlimited |
| `BOT_OWNER_USER_ID` / `CODEGEN_ALLOWLIST_USER_IDS` / `OPS_ALLOWLIST_USER_IDS` | unset | Restricted tool allowlists as Discord user IDs. If an allowlist is empty and owner is set, restricted tools default to owner-only; if owner is unset, they are open |
| `IMAGE_TOOLS_ALLOWLIST_ONLY` | `false` | When true, image generation also requires owner/ops allowlist membership |
| `DISCORD_AI_AGENT_PROCESS_ROLE` | `bot` | `api`, `bot`, `worker`, or `all`. Chat/memory need `bot`; indexing and code-update tasks need `worker`; sandbox callbacks and the run console need `api`. Use `all` for a single-process setup |
| `RUN_MIGRATIONS` | `true` | Run migrations on process startup; Helm runtime pods set this to `false` because migrations run as a hook |

Database schema setup is intentionally simple for new installs: `migrations/001_initial.sql` is the single baseline migration. If you are upgrading a database created before the migration squash, run `scripts/legacy-schema-transition.sql` once to rename the old runtime tables/columns in place before using the current baseline.

## Private Content And The Overlay Boundary

The tracked repo ships neutral defaults only. Everything specific to your server lives in one of two overlay homes, both outside Git:

- `.discord-ai-agent/` (gitignored): persona/prompt overlay, private eval prompts, skill exports, local caches.
- The database: server overlays (`server_overlays`), learned skills, aliases, and all indexed Discord content.

Customization points:

- **Persona/tone**: put instructions in `.discord-ai-agent/prompt-overlay.md` (or set `PROMPT_OVERLAY_PATH`). When present, the file is merged into the system prompt on every turn — no source edits needed. Live edits apply without a restart.
- **Server overlay**: per-guild system-prompt additions and tool policy stored in Postgres.
- **Private evals**: put server-specific prompts in `.discord-ai-agent/evals/` and run `npm run eval -- --include-private`. Committed `evals/prompts/` must stay generic.
- **Loading emoji**: set `DISCORD_LOADING_REACTION` to a custom emoji (`name:id`) instead of the default `⏳`.

`npm run scan:release` enforces the boundary: it fails if known-private strings, real-looking Discord snowflakes, or secret-shaped tokens appear in tracked files.

## Private Skills

Private server-specific skills live in Postgres, not Git.

```text
@ai learn this for next time: movie night starts at 8 unless someone says otherwise
```

Manage skills:

```bash
npm run skills -- list --all
npm run skills -- export .discord-ai-agent/skills-export.json
npm run skills -- import .discord-ai-agent/skills-export.json
npm run skills -- disable movie-night
npm run skills -- delete movie-night
```

## Security Model

- The bot only indexes bot-visible Discord messages.
- Retrieval is filtered by channels the requester can currently view.
- Code-update work runs in sandboxed runner processes; the Kubernetes backend adds per-task Job isolation.
- Code-update pushes are restricted to `agent/`-prefixed branches; base and protected branches are refused.
- Sandboxes receive scoped task secrets, not Discord tokens or database credentials.
- On Kubernetes, only the worker service account can create sandbox Jobs, Secrets, and ConfigMaps.
- Task progress and tool usage are persisted for audit/debugging.
- Private Discord data, skills, logs, database dumps, and embeddings should never be committed.
