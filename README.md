# Discord AI Agent

Discord AI Agent is a self-hosted Discord bot that gives a server a natural-language AI assistant. Users mention `@ai` and the model can answer normally, search permission-aware Discord history, summarize channel context, generate images, use hosted web/time tools, inspect app logs, and save private skills in Postgres.

This repo is designed for people running their own bot on their own Discord server. It does not include any Discord data, embeddings, private skills, logs, or deployment secrets.

## Capabilities

- Natural `@ai <request>` interaction, no command memorization required.
- Permission-aware Discord history search over bot-visible indexed messages.
- Per-channel persistent conversation memory for bot turns and tool results.
- Full-server crawl and incremental indexing through the Discord bot API.
- Background embeddings with pgvector-backed semantic retrieval.
- OpenRouter chat, embeddings, image generation, web search, web fetch, and datetime tools.
- DB-backed private skills that never need to enter Git.
- GitHub PR creation for code/tool proposals that require human review.
- Structured logs, trace IDs, tool audit logs, and owner-only Railway log inspection.

## Privacy Warning

Do not publish a production database, embedding table, trace log, `.discord-ai-agent/` directory, skill export, Railway logs, or Discord message dump. These can contain private server/member data even when API secrets are absent.

Only crawl servers where you have permission to run this kind of bot. Retrieval filters by channels the requesting Discord user can currently view, but the database still stores indexed bot-visible history.

## Requirements

- Node.js 22+
- Docker Desktop or another Postgres with `pgvector`
- A Discord application and bot account
- An OpenRouter API key
- Optional: GitHub token for PR proposal tools
- Optional: Railway token for owner-only runtime log inspection

## Local Setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run migrate
npm run invite-url
npm run preflight
npm run dev
```

Set these values in `.env`:

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OPENROUTER_API_KEY=
GITHUB_TOKEN=
GITHUB_REPOSITORY=owner/discord-ai-agent
BOT_NAME=ai
```

The generated invite URL uses least-privilege bot permissions. The bot should not be granted Administrator.

## Running Processes

The default local process role is `bot`.

```bash
npm run dev
npm run worker
DISCORD_AI_AGENT_PROCESS_ROLE=all npm run dev
```

For Docker:

```bash
docker compose up --build bot worker
```

## Indexing And Embeddings

Crawling stores bot-visible Discord messages and queues embeddings in the background:

```bash
npm run crawl
npm run reindex
npm run embeddings:backfill
npm run embeddings:worker
```

Messages become keyword-searchable before semantic search fully catches up.

## Private Skills

Committed Markdown files under `skills/` are public baseline behavior. Private server-specific skills are stored in Postgres and override public skills with the same name.

```bash
npm run skills -- list --all
npm run skills -- export .discord-ai-agent/skills-export.json
npm run skills -- import .discord-ai-agent/skills-export.json
npm run skills -- disable movie-night
npm run skills -- delete movie-night
```

`@ai learn this for next time ...` creates or updates a private database skill after policy validation.

## Useful Commands

```bash
npm run doctor
npm run smoke:discord
npm run smoke:openrouter
npm run smoke:github
npm run clear-commands
npm run blocked-users -- list
npm run blocked-users -- block 123456789012345678 "reason"
npm run aliases -- add alice alice-smith
npm run prompt -- --no-memory "status"
```

## Discord Examples

```text
@ai hello
@ai status
@ai tools
@ai undo
@ai what did we say about pizza?
@ai what did @someone say about pizza since 2024-01-01?
@ai summarize this thread
@ai next world cup match?
@ai make an image of a wizard eating nachos
@ai learn this for next time: movie night ties are settled by whoever hosted last
@ai add a tool to check the Minecraft server status
```

## Verification

```bash
npm run verify
npm run verify:db
```

Before making a public release, also run the privacy/security scan:

```bash
npm run scan:release
```

## License

MIT

