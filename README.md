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
- Isolated Kubernetes sandboxes for code-update PRs

The project is built for friend groups, clubs, small communities, and teams that want a useful shared assistant without sending their server history to a hosted bot.

## Architecture

```text
Discord mention
  -> bot/control plane
  -> model chooses tools
  -> Postgres memory, Discord tools, web tools, image tools
  -> durable agent task when code changes are requested
  -> Kubernetes sandbox job
  -> GitHub PR
  -> Discord reply edited with progress/final result
```

The app has three long-running services:

- `api`: internal callback API for sandbox task progress.
- `bot`: Discord gateway process and user-facing responses.
- `worker`: crawling, embeddings, queue processing, Kubernetes sandbox launch, reconciliation, and cleanup.

Postgres with `pgvector` is the source of truth for Discord history, embeddings, sessions, skills, traces, task events, and sandbox runs.

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
- Private DB-backed skills
- Code-update PRs through isolated Kubernetes sandbox tasks
- Structured logs and trace/task event inspection

## Requirements

Local development:

- Node.js 22+
- Docker Desktop or another Postgres instance with `pgvector`
- Discord application/bot token
- OpenRouter API key

Production:

- Kubernetes, with AWS EKS as the primary reference target
- Managed Postgres with `pgvector`
- Container registry for app/sandbox images
- Existing Kubernetes Secret containing app secrets
- GitHub App credentials, or a GitHub token for local/dev code-update PRs

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
TASK_SIGNING_SECRET=
BOT_NAME=ai
```

Generate an invite URL:

```bash
npm run invite-url
```

Invite the bot, then run:

```bash
npm run preflight
npm run dev
```

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
```

## Code Updates

When someone asks `@ai update yourself to ...`, the bot creates a durable `agent.task`, the worker starts a Kubernetes sandbox Job, and the sandbox:

1. Refreshes a cached bare clone of the configured GitHub repo.
2. Creates a per-task worktree and branch.
3. Restores dependencies from a package manifest/lockfile-keyed cache, or seeds that cache with `npm ci`.
4. Runs Codex with the requested change.
5. Refreshes dependencies again if Codex changed `package.json` or `package-lock.json`.
6. Runs verification and release scanning.
7. Pushes a branch.
8. Opens a GitHub PR only if there is a real diff.
9. Reports progress, cache hit/miss data, and phase timings back to the internal API.

The original Discord reply is edited with progress and the final PR link plus compact timing/cache details.
If a sandbox crashes, disappears, or exits without sending its terminal callback, the worker reconciler marks the task failed in Postgres and later cleans up the sandbox Job, Secret, and ConfigMap.

The sandbox also installs ephemeral helper CLIs on Codex's `PATH`:

- `agent-task-context` prints the task/repo/cache context.
- `agent-cache-info` prints cache entry counts from inside the sandbox.
- `agent-progress <step> <message>` sends an explicit task progress event.

Cache operator scripts:

```bash
npm run sandbox-cache:status
npm run sandbox-cache:prune
npm run sandbox-cache:clear
```

For a local Kubernetes full-loop test, see [docs/local-kubernetes.md](docs/local-kubernetes.md).
For production setup, see [docs/eks-deploy.md](docs/eks-deploy.md).
For the cache-first runtime and warm-sandbox direction, see [docs/codegen-runtime.md](docs/codegen-runtime.md).
For a reference AWS baseline, see [deploy/terraform/aws](deploy/terraform/aws).

## Configuration

Required:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application/client ID |
| `DISCORD_GUILD_ID` | Discord server to run in |
| `OPENROUTER_API_KEY` | Chat, embeddings, images, and hosted tools |
| `DATABASE_URL` | Postgres connection string |
| `TASK_SIGNING_SECRET` | Signs sandbox callback tokens |

Common optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_NAME` | `ai` | Display/default mention name in prompts/docs |
| `OPENROUTER_CHAT_MODEL` | `z-ai/glm-5.2` | Main agent model |
| `OPENROUTER_EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | Embedding model |
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | Image model |
| `GITHUB_REPOSITORY` | `owner/repo` | Repo for code-update PRs |
| `GITHUB_BASE_BRANCH` | `main` | PR base branch |
| `GITHUB_APP_ID` | unset | Preferred production GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | unset | Preferred production GitHub App private key |
| `GITHUB_APP_INSTALLATION_ID` | unset | Preferred production GitHub App installation ID |
| `SANDBOX_IMAGE` | `discord-ai-agent-sandbox:latest` | Kubernetes sandbox image |
| `SANDBOX_CACHE_DIR` | `/var/cache/discord-ai-agent` | Sandbox repo/npm/dependency cache path |
| `SANDBOX_CACHE_PVC_NAME` | unset | Optional Kubernetes PVC mounted at `SANDBOX_CACHE_DIR` |
| `CONTROL_PLANE_INTERNAL_URL` | `http://discord-ai-agent-api:8080` | Sandbox callback URL |
| `DISCORD_AGENT_RESPONSE_TIMEOUT_MS` | `1800000` | Max time a Discord request can keep editing the same reply while waiting for tools/code-update PRs |
| `DISCORD_AI_AGENT_PROCESS_ROLE` | `bot` | `api`, `bot`, `worker`, or `all` |
| `RUN_MIGRATIONS` | `true` | Run migrations on process startup; Helm runtime pods set this to `false` because migrations run as a hook |

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
- Code-update work runs in isolated Kubernetes sandbox Jobs.
- Sandboxes receive scoped task secrets, not Discord tokens or database credentials.
- Only the worker service account can create sandbox Jobs, Secrets, and ConfigMaps.
- Task progress and tool usage are persisted for audit/debugging.
- Private Discord data, skills, logs, database dumps, and embeddings should never be committed.
