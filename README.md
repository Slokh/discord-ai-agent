# Discord AI Agent

A self-hosted conversational agent for private Discord communities.

Members mention `@ai` and ask normally. The agent answers questions, searches permission-visible server history, inspects files and images, uses current web information, generates images, reacts and creates polls, and runs optional wallets and provably fair games.

## How it works

```text
Discord mention or reply
  -> bot persists a requester-scoped turn
  -> worker runs it in the requester's durable nanocode session
  -> model selects from the deployed typed tools
  -> application enforces permissions and side effects
  -> durable delivery posts one Discord reply
```

The worker runs one long-lived nanocode host (`native/nanocodex-runtime`) that keeps each member's session per channel or thread in Postgres. Postgres with pgvector also stores Discord history, retrieval data, conversation memory, runtime events and artifacts, delivery obligations, and optional payment and game state.

The design is model-led and code-governed: the model owns language, relevance, tool choice, and presentation; code owns requester authority, permissions, changing facts, money, randomness, durable state, and delivery.

## Capabilities

- Natural mention and reply conversation with per-member sessions
- Follow-ups sent mid-turn steer the running turn instead of queueing
- Permission-filtered Discord history, attachments, stats, and summaries
- Current web search and page reading
- Bounded document, archive, image, audio, video, and generated-data inspection
- Image generation, Discord reactions, and native polls
- Optional Privy/Tempo managed wallets, transfers, wagers, and provable RNG
- Typed runtime ledger, durable delivery, and recovery sweeps
- Optional private operator Console
- Public and private-replay evals with pass@1 and pass^k

## Documentation

Start with the [documentation index](docs/README.md).

- [Product](docs/product.md): user experience and trust boundaries
- [Architecture](docs/architecture.md): processes, lifecycles, sources of truth, and code ownership
- [Agent system](docs/agent-system.md): nanocode host, sessions, prompts, tools, results, and delivery
- [Data](docs/data.md): Discord indexing, retrieval, memory, sessions, privacy, and retention
- [Payments and games](docs/payments.md): wallets, transfers, wagers, and randomness
- [Operations](docs/operations.md): setup, configuration, Console, deployment, and debugging
- [Configuration](docs/configuration.md): generated environment-variable contract
- [Development](docs/development.md): investigation, implementation, tests, evals, and PR workflow

Coding agents must also follow [AGENTS.md](AGENTS.md).

## Quick start

Requirements: Node.js 22.19+, Rust 1.97, Postgres with pgvector, a Discord bot, and an OpenRouter key.

```bash
git clone https://github.com/your-org/discord-ai-agent.git
cd discord-ai-agent
npm install
cargo install --locked --path native/nanocodex-runtime
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

The bot accepts requests and delivers results; the worker runs queued turns through the nanocode host, which it starts from `PATH`.

## Index Discord history

New Discord events are stored while the bot runs. Import older visible history and fill semantic embeddings with:

```bash
npm run crawl
npm run embeddings:backfill
```

Keyword retrieval works before embeddings exist. Run `npm run embeddings:worker` to embed new messages continuously.

## Optional integrations

- Wallets, member transfers, and wallet-backed wagers appear when both Privy credentials are configured.
- The configured Discord owner and ops allowlists gate restricted tools.
- The operator Console is an optional role; see [Operations](docs/operations.md#operator-console).

The accepted environment is documented in [`.env.example`](.env.example). Stable product and architecture settings are versioned in `src/config/env.ts`.

## Development checks

```bash
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

The runtime ledger is retained in Postgres; use the configured production database or a trusted application pod for operational investigation. See [Operations](docs/operations.md).

## Private data

Tracked source contains neutral defaults only. Deployment-specific prompt guidance and private evals belong under the gitignored `.discord-ai-agent/` directory; Discord content, overlays, memory, sessions, and traces belong in Postgres. `npm run scan:release` enforces this boundary.

Use [GitHub private vulnerability reporting](https://github.com/Slokh/discord-ai-agent/security/advisories/new) for security issues. See [SECURITY.md](SECURITY.md).
