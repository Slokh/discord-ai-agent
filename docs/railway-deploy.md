# Railway Deployment

Discord AI Agent can run on Railway as three services:

- `discord-ai-agent-db`: Postgres with `pgvector`
- `discord-ai-agent-bot`: the Discord gateway bot
- `discord-ai-agent-worker`: crawl and embedding background jobs

Railway does not run `docker-compose.yml` directly. Create bot and worker services from the same GitHub repo and give each service its own start command.

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

## Variables

Set these on both bot and worker services:

```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
OPENROUTER_API_KEY=...
GITHUB_TOKEN=...
GITHUB_REPOSITORY=owner/discord-ai-agent
BOT_NAME=ai
NODE_ENV=production
LOG_LEVEL=info
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
```

## First Deploy

1. Deploy Postgres.
2. Deploy `discord-ai-agent-worker`.
3. Watch worker logs until migrations and pg-boss startup complete.
4. Deploy `discord-ai-agent-bot`.
5. Stop any local bot process for the same Discord app.
6. In Discord, test:

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
- The worker logs into Discord because the crawler needs bot-visible channel/thread access, but it does not handle user mentions.
- Bot and worker both run migrations on startup. Migrations use a Postgres advisory lock so first deploys do not race.
- No HTTP port is required; these are long-running background services.
- If replies hang, check app traces first with `@ai`, then Railway logs if owner-only log inspection is configured.
- If history answers are keyword-only or weak, check `@ai status` for embedding backlog.

