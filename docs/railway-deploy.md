# Railway Deployment

Discord AI Agent can run on Railway as four services:

- `discord-ai-agent-db`: Postgres with `pgvector`
- `discord-ai-agent-bot`: the Discord gateway bot
- `discord-ai-agent-worker`: crawl and embedding background jobs
- `discord-ai-agent-codegen`: Railway-native coding jobs that can open implementation PRs

Railway does not run `docker-compose.yml` directly. Create bot, worker, and codegen services from the same GitHub repo and give each service its own start command.

## Prerequisites

- A GitHub repo connected to Railway.
- A Railway Postgres service that supports the `vector` extension.
- Discord, OpenRouter, and optional GitHub/Railway tokens.
- Exactly one running bot process for the target Discord application.

## Services

### `discord-ai-agent-bot`

- Builder: Dockerfile
- Root directory: repo root
- Start command:

```bash
npm run start:bot
```

- Replicas: `1`
- Public domain: none needed

### `discord-ai-agent-worker`

- Builder: Dockerfile
- Root directory: repo root
- Start command:

```bash
npm run start:worker
```

- Replicas: `1` to start
- Public domain: none needed

### `discord-ai-agent-codegen`

- Builder: Dockerfile
- Root directory: repo root
- Start command:

```bash
npm run start:codegen
```

- Replicas: `1` to start
- Public domain: none needed
- Purpose: consumes `agent.codegen` jobs through the default portable codegen backend, clones the configured GitHub repo into Railway's ephemeral filesystem, runs Codex, verifies generated changes, pushes a branch, and opens a PR only when there is a real diff. The queue is internal: the Discord bot waits on the persisted job result and edits the original reply with phase progress, the PR link, or a failure/no-change result.

## Variables

Set these on all app services:

```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
OPENROUTER_API_KEY=...
GITHUB_TOKEN=...
GITHUB_REPOSITORY=owner/discord-ai-agent
NODE_ENV=production
LOG_LEVEL=info
```

Set these on the bot and worker services:

```bash
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
BOT_NAME=ai
```

Set this on `discord-ai-agent-bot` only if you want owner-only Railway log inspection:

```bash
RAILWAY_TOKEN=...
RAILWAY_PROJECT_ID=...
RAILWAY_ENVIRONMENT=production
RAILWAY_LOG_OWNER_USER_IDS=123456789012345678
```

Optional role variables are redundant with the start commands, but harmless:

```bash
DISCORD_AI_AGENT_PROCESS_ROLE=bot
DISCORD_AI_AGENT_PROCESS_ROLE=worker
DISCORD_AI_AGENT_PROCESS_ROLE=codegen
```

## First Deploy

1. Deploy Postgres.
2. Deploy `discord-ai-agent-worker`.
3. Watch worker logs until migrations and pg-boss startup complete.
4. Deploy `discord-ai-agent-codegen`.
5. Watch codegen logs until pg-boss startup completes.
6. Deploy `discord-ai-agent-bot`.
7. Stop any local bot process for the same Discord app.
8. In Discord, test:

```text
@ai status
@ai hello
@ai what can you do
```

## CI And Deploy Flow

Use pull request checks before deploying:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run scan:release`

Do not push directly to a production branch. Open a PR, wait for CI, review it, then merge manually.

## Existing Data

Never commit database dumps, logs, embeddings, private skills, or exports. To restore a private database into Railway, keep dump files outside Git:

```bash
pg_dump --format=custom --no-owner --no-acl --exclude-schema=pgboss \
  --file discord-ai-agent.dump \
  "$SOURCE_DATABASE_URL"

pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname "$RAILWAY_DATABASE_URL" \
  discord-ai-agent.dump
```

## Operational Notes

- Keep exactly one bot replica. Multiple bot replicas can all receive the same Discord mention and double-reply.
- One worker replica is enough initially. Add more only if embedding/crawl throughput is too slow and OpenRouter rate limits are healthy.
- One codegen replica is enough. Add more only if you are comfortable with multiple coding jobs running concurrently against the same GitHub repo.
- The worker logs into Discord because the crawler needs bot-visible channel/thread access, but it does not handle user mentions.
- The codegen service does not log into Discord. It only needs `DATABASE_URL`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, and `GITHUB_REPOSITORY`.
- Bot and worker both run migrations on startup. Migrations use a Postgres advisory lock so first deploys do not race.
- No HTTP port is required; these are long-running background services.
- If replies hang, check app traces first with `@ai`, then Railway logs if owner-only log inspection is configured.
- If history answers are keyword-only or weak, check `@ai status` for embedding backlog.
