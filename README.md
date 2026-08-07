# Discord AI Agent

A self-hosted conversational agent for private Discord communities.

Members mention `@ai` and ask normally. The agent can answer questions, search permission-visible server history, inspect files and images, use current web information, create Discord-native responses, manage optional wallets and games, and open code-update pull requests for itself.

## How it works

```text
Discord mention or reply
  -> bot persists a requester-scoped turn
  -> worker runs the retained NanoCodex session
  -> model selects from deployed typed tools
  -> application enforces permissions and side effects
  -> durable delivery posts one final Discord response
```

Postgres with pgvector stores Discord history, retrieval data, conversation memory, runtime events and artifacts, delivery obligations, task state, and optional payment/game state. Chat executes inside the application. Repository changes execute in isolated Kubernetes Jobs and end in a verified GitHub PR.

The design is model-led and code-governed: the model owns language, relevance, tool choice, and presentation; code owns requester authority, permissions, changing facts, money, randomness, durable state, and delivery.

## Capabilities

- Natural mention/reply conversation with retained thread context
- Permission-filtered Discord history, attachments, stats, and summaries
- Current web search and external provider tools
- Bounded document, archive, image, audio, video, and generated-data inspection
- Image generation and Discord Components V2 presentation
- Unified private improvement cases from member, agent, operator, and runtime signals
- Private operator dashboard for live services, prompts, code work, improvements, and releases
- Optional Spotify catalog tools
- Optional Privy/Tempo managed wallets, transfers, wagers, and provable RNG
- Sandboxed repository changes with verification, release scanning, and PR publication
- Typed runtime ledger, signed sandbox callbacks, and recovery sweeps
- Accepted improvement contracts exported into a private executable regression suite

## Documentation

Start with the [documentation index](docs/README.md).

- [Product](docs/product.md): user experience and trust boundaries
- [Architecture](docs/architecture.md): processes, lifecycles, sources of truth, and code ownership
- [Agent system](docs/agent-system.md): NanoCodex, prompts, tools, results, presentation, and delivery
- [Data](docs/data.md): Discord indexing, retrieval, memory, database, privacy, and retention
- [Payments and games](docs/payments.md): wallets, transfers, wagers, and randomness
- [Code updates](docs/code-updates.md): sandboxed repository work and GitHub publication
- [Operations](docs/operations.md): setup, configuration, deployment, observability, and debugging
- [Configuration](docs/configuration.md): generated accepted environment-variable contract
- [Development](docs/development.md): investigation, implementation, tests, evals, and PR workflow

Coding agents must also follow [AGENTS.md](AGENTS.md).

## Quick start

Requirements: Node.js 22+, Postgres with pgvector, a Discord bot, and an OpenRouter key.

```bash
git clone https://github.com/your-org/discord-ai-agent.git
cd discord-ai-agent
npm install
cp .env.example .env
docker compose up -d postgres
npm run migrate
```

Set these values in `.env`:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OPENROUTER_API_KEY=
DATABASE_URL=postgres://discord_ai_agent:discord_ai_agent@localhost:5433/discord_ai_agent
```

Generate the least-privilege invite and run preflight:

```bash
npm run invite-url
npm run preflight
```

Start the bot and worker in separate terminals:

```bash
npm run dev
```

```bash
npm run worker
```

The bot accepts requests and delivers results; the worker executes queued chat turns. Start `npm run api` only when code-update sandbox callbacks are enabled.

Run `npm run console` for the deployed private production dashboard, or `npm run console:dev` to restart and automatically reload the branch's local UI on edits while it reads the live production snapshot. Both workflows stay on loopback through Kubernetes. Use `npm run console:local` only when intentionally developing against local data; never publish the console as a public endpoint.

## Index Discord history

New Discord events are stored while the bot runs. Import older visible history and fill semantic embeddings with:

```bash
npm run crawl
npm run embeddings:backfill
```

The worker drains the embedding queue. Keyword retrieval works before embeddings finish.

## Optional code updates

Set a fine-grained `GITHUB_TOKEN` or GitHub App credentials and `TASK_SIGNING_SECRET`, then start the worker and API roles. The model then receives code-update tools and can turn explicit repository requests into sandboxed PRs for this repository.

Each task gets its own Kubernetes Job, task-scoped credentials, worktree, verification, and cleanup. See [Code updates](docs/code-updates.md) and [Operations](docs/operations.md).

## Optional integrations

- Spotify tools appear when both Spotify client credentials are configured.
- Wallets, member transfers, and wallet-backed wagers appear when both Privy credentials are configured.
- Administrative mutations use the configured Discord owner/ops allowlists.

The small accepted environment surface is documented in [`.env.example`](.env.example). Stable product and architecture settings are versioned in `src/config/env.ts`.

## Development checks

```bash
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

The runtime ledger is retained in Postgres; use the configured production database or a trusted application pod for operational investigation. See [Operations](docs/operations.md).

## Private data

Tracked source contains neutral defaults only. Deployment-specific prompt guidance and private evals belong under the gitignored `.discord-ai-agent/` directory; Discord content, overlays, memory, markers, and traces belong in Postgres. `npm run scan:release` enforces this boundary.

Use [GitHub private vulnerability reporting](https://github.com/Slokh/discord-ai-agent/security/advisories/new) for security issues. See [SECURITY.md](SECURITY.md).
