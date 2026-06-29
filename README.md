# Discord AI Agent

A self-hosted AI bot for private Discord servers.

Mention `@ai` and it can answer questions, search your server's history, summarize channels, generate images, look things up on the web, and remember private server-specific skills. The interface is deliberately simple: users talk to it like a person, and the model decides which tools to use.

This is built for friend groups, clubs, communities, and small teams that want a useful AI assistant without handing their Discord history to a hosted SaaS bot.

## Why This Exists

Most Discord bots make users learn commands. Most AI chat apps do not understand your server. Discord AI Agent is the middle path:

- One natural interface: `@ai what did we say about pizza?`
- Permission-aware memory over indexed Discord history.
- Persistent per-channel conversation context.
- Web search, image generation, stats, summaries, and private skills.
- Self-hosted code and database, so your server data stays under your control.

The goal is not to be a generic Discord bot framework. It is a practical AI agent you can run for your own server and extend over time.

## How It Works

```text
Discord mention
  -> agent router
  -> model chooses tools
  -> local tools query Postgres / Discord history / GitHub / Railway
  -> hosted OpenRouter tools handle web, fetch, and time
  -> one conversational Discord reply
```

Discord AI Agent stores bot-visible messages in Postgres, creates embeddings with OpenRouter, and uses pgvector plus keyword search for retrieval. Every history lookup is filtered by the channels the requesting Discord user can currently view.

Private skills are stored in the database, not Git. Public baseline behavior can live in Markdown under `skills/`, but server-specific memories learned through `@ai learn this for next time ...` stay private.

## What You Get

- Natural `@ai <request>` interaction.
- Full-server crawl through the Discord bot API.
- Incremental indexing for new, edited, and deleted messages.
- Permission-aware history search.
- Per-channel persistent conversation memory.
- Channel and user stats.
- Thread/channel summaries.
- Image generation.
- Hosted web search, web fetch, and datetime tools through OpenRouter.
- Private DB-backed skills.
- Optional GitHub PR creation for requested agent updates.
- Structured logs, trace IDs, and owner-only Railway log inspection.

## What You Need

- Node.js 22+
- Docker Desktop, or another Postgres instance with `pgvector`
- A Discord application/bot token
- An OpenRouter API key
- Optional: a GitHub token if you want PR proposal tools
- Optional: Railway if you want to deploy it there

## Quickstart

Clone and install:

```bash
git clone https://github.com/Slokh/discord-ai-agent.git
cd discord-ai-agent
npm install
cp .env.example .env
```

Start Postgres:

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
BOT_NAME=ai
```

Generate an invite URL:

```bash
npm run invite-url
```

Invite the bot to your server, then run checks:

```bash
npm run preflight
```

Start the bot:

```bash
npm run dev
```

In Discord:

```text
@ai hello
@ai what can you do?
@ai status
```

## Index Your Server History

The bot can answer normal questions immediately. To let it search old Discord messages, run a crawl:

```bash
npm run crawl
```

For larger servers, keep a worker running so embeddings process in the background:

```bash
npm run worker
```

Messages become keyword-searchable as soon as they are stored. Semantic search improves as embeddings finish.

Useful indexing commands:

```bash
npm run crawl                 # continue/resume crawling
npm run reindex               # reset crawl cursors and crawl again
npm run embeddings:backfill   # enqueue missing/stale embeddings
npm run embeddings:worker     # process embedding jobs only
```

## Discord Setup Notes

In the Discord Developer Portal:

1. Create an application.
2. Add a bot.
3. Enable these privileged gateway intents:
   - Server Members Intent
   - Message Content Intent
4. Copy the bot token into `DISCORD_TOKEN`.
5. Copy the application/client ID into `DISCORD_CLIENT_ID`.
6. Copy your server ID into `DISCORD_GUILD_ID`.
7. Run `npm run invite-url` and invite the bot.

The bot does not need Administrator. It only indexes and answers from channels it can see, and users only retrieve history from channels they can currently view.

## Example Prompts

```text
@ai what did we say about buying a projector?
@ai summarize what happened in this channel this week
@ai rank channels by messages per day
@ai what are the recurring topics in #movies?
@ai find the message where someone mentioned "the projector setup"
@ai next world cup match?
@ai make an image of a wizard eating nachos
@ai learn this for next time: movie night ties are settled by whoever hosted last
@ai add a tool to check our Minecraft server status
```

## Configuration

Required:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application/client ID |
| `DISCORD_GUILD_ID` | Server to run in |
| `OPENROUTER_API_KEY` | Chat, embeddings, images, and hosted tools |

Common optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_NAME` | `ai` | Name used in examples and prompts |
| `OPENROUTER_CHAT_MODEL` | `deepseek/deepseek-v4-flash` | Main agent model |
| `OPENROUTER_EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | Embedding model |
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | Image model |
| `GITHUB_TOKEN` | unset | Enables skill PRs and Railway codegen PRs |
| `GITHUB_REPOSITORY` | `owner/discord-ai-agent` | Repo for skill PRs and codegen jobs |
| `DISCORD_AI_AGENT_PROCESS_ROLE` | `bot` | `bot`, `worker`, `codegen`, or `all` |

For `@ai add/build/implement ...` requests, run a separate Railway service with `npm run start:codegen`. The bot keeps the Discord reply open while the codegen worker clones the repo, runs Codex in an ephemeral checkout, commits only if there is a real diff, and opens a PR. When the worker finishes, the bot edits the original Discord reply with the PR link or the failure/no-change result.

## Running Locally

One-process local development:

```bash
npm run dev
```

Separate bot, worker, and codegen processes:

```bash
npm run bot
npm run worker
npm run codegen
```

Docker:

```bash
docker compose up --build bot worker codegen
```

Local prompt testing without Discord:

```bash
npm run prompt -- --no-memory "what can you do?"
```

## Private Skills

Skills are reusable instructions the agent loads into its system prompt.

Public/default skills can live in `skills/*.md`. Private server-specific skills live in Postgres and should not be committed. The Discord command:

```text
@ai learn this for next time: movie night starts at 8 unless someone says otherwise
```

creates or updates a private database skill after policy checks.

Manage DB-backed skills:

```bash
npm run skills -- list --all
npm run skills -- export .discord-ai-agent/skills-export.json
npm run skills -- import .discord-ai-agent/skills-export.json
npm run skills -- disable movie-night
npm run skills -- delete movie-night
```

## Deployment

Railway works well for the first hosted deployment:

- Postgres service with persistent volume.
- Bot service with `DISCORD_AI_AGENT_PROCESS_ROLE=bot`.
- Worker service with `DISCORD_AI_AGENT_PROCESS_ROLE=worker`.
- Codegen service with `DISCORD_AI_AGENT_PROCESS_ROLE=codegen`.
- All app services connected to the same GitHub repo and database.

See [docs/railway-deploy.md](docs/railway-deploy.md) for a detailed Railway setup.

## Privacy And Safety

Do not publish:

- `.env` files
- production database dumps
- embeddings
- trace logs
- Railway logs
- `.discord-ai-agent/`
- private skill exports
- Discord message exports

Even without API keys, those files can contain private server/member data.

Before making a public release, run:

```bash
npm run scan:release
```

## Development

```bash
npm run verify      # lint, typecheck, tests, audit
npm run verify:db   # migration + pgvector integration tests
```

Useful diagnostics:

```bash
npm run doctor
npm run smoke:discord
npm run smoke:openrouter
npm run smoke:github
```

## License

MIT
