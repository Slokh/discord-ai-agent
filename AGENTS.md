# Discord AI Agent Coding Guide

This repository is a TypeScript Discord assistant for private communities. Users talk to it naturally; the model chooses tools; code enforces identity, permissions, money, randomness, durability, and delivery. Changes should preserve that division.

## Friction Log

- Log papercuts and friction in tooling, docs, APIs, tests, or conventions as you hit them with `npx frog log`.
- Do not add global, system, or internal friction.
- Run `npx frog list` first to see what is already known.

## Read First

Use this order for a new task:

1. [`docs/product-principles.md`](docs/product-principles.md) for the product contract and decision rules.
2. [`docs/architecture.md`](docs/architecture.md) for the runtime and end-to-end flows.
3. [`src/README.md`](src/README.md), then the nearest `src/**/README.md`, for ownership and tests.
4. [`docs/engineering-guide.md`](docs/engineering-guide.md) for feature workflow, verification, debugging, and PR handoff.
5. [`docs/tool-design.md`](docs/tool-design.md) before changing model-facing tools.

[`docs/README.md`](docs/README.md) is the full documentation index and identifies active versus historical plans.

## Product Contract

- Keep Discord commandless. Users should write ordinary `@ai ...` requests, including admin and debugging requests; do not add slash-command-shaped product flows.
- Keep replies conversational, concise, and proportional. Avoid canned forms, walls of text, unnecessary headings, repeated conclusions, and implementation jargon.
- Prefer model-led intent, tool choice, wording, and formatting. Do not add prompt-specific regex branches or preformatted responses when a generic tool contract, prompt instruction, or structured result will work.
- Use deterministic code for facts the model must not invent or authorize: requester identity, permissions, live balances, transfers, fee sponsorship, randomness, wager state, idempotency, and delivery state.
- Treat the current requester and Discord reply chain as hard scope. Never reuse another member's identity, wallet authority, game state, or unrelated session context.
- Live data requires live evidence. Prices, fares, schedules, availability, Discord facts, wallet balances, and transaction state come from tools or durable sources, never model memory.
- Make new features observable. Important model calls, external calls, retries, failures, latency, costs, and state transitions need typed events, spans, audits, or artifacts that the run console and scripts can explain.
- Optimize for a friendly private-server threat model without weakening money, secrets, privacy, permission filtering, or destructive-action boundaries.

## Workflow

- Treat production as the default operating target. Debugging, run/task inspection, and the live console use the production control plane through the configured URL or current local Kubernetes context; never silently fall back to localhost or a local database. Isolated local work must be explicitly requested with the tool's local/DB option.
- Use `rg` first, then read the smallest owning files needed for the next concrete edit.
- Do not spend the whole run inspecting. Once the relevant lifecycle is clear, add the focused test or implementation change.
- For bugs, reproduce from the run trace or add a failing regression test before or alongside the fix.
- For complex features, trace the full lifecycle: ingress, durable state, tool/model behavior, Discord delivery, observability, cleanup, and docs.
- Discover repository and runtime facts yourself and make reasonable in-scope assumptions. Ask the user only when a missing choice would materially change product behavior, authority, or external side effects.
- Keep new source files focused. If a file owns multiple domains or approaches the architecture size guard, split it before adding another responsibility.
- Preserve existing user changes in a dirty worktree and avoid destructive Git operations.

### Debugging Discord regressions

- The production-targeting scripts are the default: `npm run discord:debug`, `npm run discord:audit`, `npm run runs:inspect`, and `npm run tasks:status`. Pass `--source db` only for deliberate isolated local inspection.
- For one Discord prompt, run `npm run discord:debug -- <discord-message-link>` before reading source or attributing a failure to the model.
- For a report since deployment, run `npm run discord:audit -- --channel <id> --since-deploy --include-reply-chains`; inspect all bot replies, bot requests without replies, and reply chains in scope before editing.
- Use `npm run runs:inspect` with `--channel`, `--revision`, `--since`, or `--warnings-only` for ledger-level narrowing. Do not use browser automation when these script and trace paths are available.
- Compare ingress request, retained reply chain, session memory, operative final user message, selected tools, typed outcome state, and Discord delivery as separate artifacts. Group identical failures by revision before proposing a fix.
- Do not blame a model/provider until prompt shape, tool evidence, deterministic state, and delivery trace agree. Add focused contract coverage at the earliest layer that should have prevented the observed failure.

## Core Flows

- Discord mentions enter through `src/discord/client.ts` and `src/discord/messageIngress.ts`, then execute through `src/agent/runtimeRunner.ts` and `src/agent/router.ts`.
- Discord-visible acknowledgements, status replies, final replies, files, footers, reactions, and loading cleanup go through `src/discord/responseSink.ts`.
- Replayable turn payloads are built in `src/agent/runtimeEnvelope.ts`. Discord chat executes in-process; sandboxes are only for code-update tasks.
- Model-facing contracts live in `src/tools/registry.ts`; implementations live in focused tool-family modules under `src/tools/`.
- The canonical execution ledger is `src/db/agentRuntimeRepository.ts` and the `agent_runtime_*` tables. Do not create a second chat/task execution history.
- Code-update tasks flow through `src/tools/agentTaskTools.ts`, `src/jobs/agentTaskEnqueue.ts`, `src/jobs/queue.ts`, `src/execution/backend.ts`, and the focused execution pipeline described in `src/execution/README.md`.
- The run console API is in `src/control/internalApi.ts`; reusable run derivation is in `src/observability/`; React UI is under `src/control/console/`.
- Wallet and wager invariants are documented in `docs/wallets.md`; provable randomness is documented in `docs/provable-rng.md`.

## Ownership Map

- Discord ingress, permissions, and message lifecycle: `src/discord/README.md`
- Model loop and prompt composition: `src/agent/README.md`
- Tool contracts and implementations: `src/tools/README.md`
- Durable data and retrieval: `src/db/README.md`
- Code-update sandbox and harness runtime: `src/execution/README.md`
- Jobs and queue handoff: `src/jobs/README.md`
- Wallets and reconciliation: `src/payments/README.md`
- Control API and debugging UI: `src/control/README.md` and `src/control/console/README.md`

If a request changes Discord knowledge, indexing, embeddings, retrieval, stats, summaries, emoji learning, or attachment search, start at the durable data/indexing owners before changing tool descriptions.

## High-Risk Invariants

- Discord history and artifacts remain permission-filtered to channels the requester can currently view.
- The immutable requester scope is established at ingress and revalidated for wallet, admin, game, debugging, and destructive actions.
- USDC.e is presented as USD or `$`; balances are read live and transaction results are receipt-verified. The bot wallet sponsors user-wallet fees.
- Chance outcomes come only from `drawRandom`; multi-turn games must persist or settle exactly once through the scoped wager lifecycle.
- Mutating operations require explicit current-turn intent. Prior memory or a replied-to message cannot authorize a transfer, deletion, admin action, or wager.
- Private server content belongs in `.discord-ai-agent/` or Postgres, not tracked source, fixtures, docs, or public evals.
- The console exposes observed inputs, outputs, tools, events, and timing—not private chain-of-thought.

## Testing And Handoff

- Run the closest focused test first.
- Run `npm run typecheck` for TypeScript changes and `npm run verify` for a broad final check.
- Run `npm run verify:db` for migrations, repositories, payments, RNG, queue, or other Postgres behavior.
- Run `npm run eval -- --dry-run` for eval schema changes; use live `npm run eval` only when configured DB/OpenRouter behavior is intended.
- Run `npm run build` for production console/build changes and cover reusable console behavior with focused unit tests.
- Add or update a focused regression test for every bug fix. Add private server prompts under `.discord-ai-agent/evals`, never committed `evals/prompts`.
- Update the nearest domain README when ownership, invariants, or a core flow changes.
- In sandboxed code-update tasks, do not commit, push, or open PRs; the runner owns Git publication.
- In direct repository work, open a ready-for-review, non-draft PR when asked. Do not merge or deploy unless the user explicitly asks.
