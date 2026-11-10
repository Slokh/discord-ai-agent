# Discord AI Agent: Fresh-Agent Guide

This is a private-community Discord assistant. Members use ordinary `@ai ...`
messages; the model handles meaning, tool choice, and wording, while code
enforces authority, live facts, money, randomness, durable state, and delivery.

## Start Every Task

1. Run `git status --short` and `git branch --show-current`. Preserve unrelated
   work; use an isolated worktree/branch when the current one is mixed.
2. Read [`docs/product.md`](docs/product.md), then use the routing table below
   to read only the owning guide.
3. Use `rg` to find the named behavior, tool, event, or lifecycle. For a
   production problem, inspect the retained run before guessing from source.

[`docs/README.md`](docs/README.md) is the documentation index,
[`docs/architecture.md`](docs/architecture.md) the runtime and ownership map, and
[`docs/development.md`](docs/development.md) the implementation and verification
workflow.

## How a Turn Runs

1. **Ingress (bot).** `src/discord/client.ts` → `messageIngress.ts` persists the
   message and `turnPreparation.ts` resolves reply context and stores a
   requester-scoped turn envelope (`src/agent/runtimeEnvelope.ts`). The request
   ID is the Discord message ID. `src/agent/runtimeLifecycle.ts` enqueues an
   `agent.runtime.execution` pg-boss job.
2. **Queue (worker).** `src/jobs/queue.ts` first offers the job to
   `steerFollowUp` in `src/discord/agentRuntimeRunner.ts`: a follow-up from the
   requester whose turn is still running joins that turn, its own execution
   and delivery obligation close, and the message gets 👀. Otherwise the job
   waits its turn in a per-thread serial queue.
3. **Session.** `src/agent/nanocodexAgentRuntime.ts` builds stable instructions,
   turn context, and the requester's message wrapped as
   `<message from="..." user_id="...">`. The session key is (Discord channel or
   thread, requester, hash of instructions + tool catalog + model), so a deploy
   that changes the contract starts a fresh session. A new session receives
   recent conversation once as bootstrap context. Images on the current message
   and its direct reply parent go to the model inline (`src/agent/turnImages.ts`).
   `src/db/nanocodeSessionRepository.ts` maps each session to its requester and
   thread.
4. **Host.** `src/agent/sharedNanocodeHost.ts` starts one long-lived
   `discord-agent-nanocodex-runtime` process per worker (`src/agent/nanocodeHost.ts`)
   and speaks a JSON-lines protocol over stdio
   (`native/nanocodex-runtime/src/protocol.rs`). Sessions are durable in the
   Postgres schema `nanocode` through nanocode's `SqlStore` on tokio-postgres
   (`native/nanocodex-runtime/src/store.rs`); a retried job with the same request ID recovers or replays
   the recorded turn instead of calling the model again.
5. **Tools.** Each tool call crosses back to Node, where
   `src/agent/toolDispatcher.ts` revalidates and gates it and dispatches to
   `src/tools/handlers/`. Calls run concurrently.
6. **Recovery.** A turn that fails before any tool ran is retried once on the
   fallback model (`openai/gpt-6-sol`). A turn that ends without reply text gets
   one repair turn in the same session. Reasoning is high for chat turns and low
   for helper calls (`src/agent/modelPolicy.ts`).
7. **Delivery.** `src/discord/agentDelivery.ts` persists a delivery intent;
   `src/discord/responseSink.ts` posts it. `deliverySweep.ts` replays unfinished
   obligations on bot startup.

The model-visible tool list is exactly `TOOL_NAMES_BY_CAPABILITY` in
`src/tools/toolDefinition.ts`, narrowed only by each contract's `available`
predicate.

## Route the Request

| Request shape | Start here | Required approach |
| --- | --- | --- |
| A Discord reply is wrong, slow, missing, or confusing | Production ledger evidence and [`docs/operations.md`](docs/operations.md) | Compare ingress, reply chain, operative request, tool calls/results, guards, model I/O, and delivery. Do not blame a model or scrape Discord in a browser first. |
| Many replies regressed after a deploy | Production ledger evidence | Audit the whole channel, including role-triggered requests and reply chains; cluster failures by deployed revision before editing. |
| Model conversation, prompt, or tool use is poor | [`docs/agent-system.md`](docs/agent-system.md), `src/agent/`, and the run's prompt artifacts | Improve general prompt/tool/result contracts. Do not add regex routes or canned replies for one wording. Measure with evals. |
| Model, reasoning level, fallback, or token cost | `productConfig` in `src/config/env.ts`, `src/agent/modelPolicy.ts`, and observed run cost | Verify the deployed configuration before changing it, keep a fallback, and compare with `npm run eval -- --repeat 3`. |
| A new or changed model-facing tool | [`docs/agent-system.md`](docs/agent-system.md) | Define the contract, schema, examples, output promise, handler, and focused coverage in the owning tool family; add the name to `TOOL_NAMES_BY_CAPABILITY`. |
| Discord history, attachments, members, stats, or memory | [`docs/data.md`](docs/data.md) | Fix persistence, indexing, or permission filtering before prompt wording. Current requester permissions always bound retrieval. |
| Wallet, transfer, wager, coin flip, blackjack, or RNG | [`docs/payments.md`](docs/payments.md) | Protect live balances, current-turn mutation intent, receipt verification, reservations, provable entropy, and exactly-once settlement. Run DB-backed verification. |
| The native runtime or its Rust dependencies | `native/nanocodex-runtime/` and the nanocode repository | Keep dependencies in sync with nanocode (below). Run `cargo test` and `npx vitest run tests/native`. |
| CI failure | `gh run view --log-failed` and local reproduction | Read the exact failed log and reproduce the command before editing. |
| Deployment, console, trace, cost, or observability | [`docs/operations.md`](docs/operations.md) | Add typed events or artifacts first; derive views from the runtime ledger. Separate build, migration, rollout, readiness, and delivery. Never expose chain of thought. |
| Database, migration, retention, or privacy deletion | [`docs/data.md`](docs/data.md) | Use forward-only migrations, focused repositories, durable idempotency/concurrency controls, and privacy-deletion coverage. |
| Cleanup, simplification, or removal | [`docs/architecture.md`](docs/architecture.md) and `rg` | Remove unused code after proving callers, migrations, and deploy config no longer need it. Do not keep dead compatibility “just in case.” |

## Product Rules That Must Hold

- Keep Discord conversational and commandless. Replies are concise and natural;
  internal implementation language, boilerplate, and needless headings do not
  belong in normal answers.
- The model owns semantic judgment: intent, follow-up meaning, tool selection,
  evidence relevance, wording, formatting, and harmless server culture.
- Code owns facts the model must not invent or authorize: identity, permissions,
  live external data, money, randomness, idempotency, durable state, and delivery.
- The current requester and current-turn intent are immutable authority. Reply
  chains, sessions, and memory provide context, never new authority for money,
  admin, deletion, secrets, or wagers.
- Accept harmless self-described aliases and server lore conversationally. Verify
  identity only when it affects protected authority.
- Use current tool or durable evidence for changing facts. Never turn model
  memory, a stale snippet, or a previous reply into a live balance, price,
  availability, Discord fact, or transaction result.
- Private Discord content belongs in Postgres or `.discord-ai-agent/`, never in
  committed source, fixtures, documentation, public evals, GitHub issues, or PR
  bodies.

## Implementation Standards

- Trace the full lifecycle for cross-domain changes: ingress, scope, durable
  state, model/tool contract, execution, Discord delivery, observability,
  recovery, and verification.
- Prefer a better data lifecycle, schema, tool result, prompt instruction, or
  general invariant to prompt-keyword logic. Deterministic guards are for stable,
  high-consequence capabilities, not ordinary language understanding.
- Keep model-facing contracts in focused `src/tools/contracts/` modules and
  execution adapters in `src/tools/handlers/`. Cross-turn feature integration
  belongs in `src/capabilities/`. The generic `src/agent/` loop consumes only
  those extension contracts; `registry.ts` aggregates and does not become a
  behavioral switchboard.
- Use `src/discord/responseSink.ts` for Discord-visible delivery. Use
  `agent_runtime_*` as the execution ledger; do not create a parallel history or
  run tracker.
- Record important tool, model, and external calls, outcomes, retries, latency,
  cost, and state transitions as typed runtime events. Put sensitive detail in
  redacted retained artifacts, not event metadata.
- Before changing skills or prompts, distinguish static repository guidance
  (`skills/`), private overlay content, and retrieved conversation context.
- Treat production as the default target for run inspection. Use a configured
  application pod or the production database; never let a local default
  masquerade as production evidence.
- Use the repository-local `$discord-production-debug` skill
  (`.agents/skills/`) for Discord links, deployed reply regressions, and
  production audits. Treat a `discord.com/channels/...` URL as a production
  reference: inspect its retained ledger evidence before reading source or
  opening Discord. If evidence is unavailable, diagnose the database, Discord
  API, authentication, or permission path and report the concrete blocker.
- Keep `native/nanocodex-runtime` dependencies in sync with nanocode: the same
  nanocode rev for every git dependency and `[patch.crates-io]` entry, the same
  versions as nanocode's workspace, and a lockfile seeded from nanocode's. Bump
  the rev in its own commit, and read nanocode's `DECISIONS.md` diff between
  the old and new revs before bumping.

## Evals

- Code graders come first: expected and forbidden tools, required and forbidden
  text, forbidden runtime events, answer length. A judge model
  (`scripts/evalJudge.ts`) grades only a case's `rubric`, optionally against a
  `referenceAnswer`, and only after the code checks pass.
- The public suite is `evals/prompts/core.json` and stays generic. Production
  replays contain member content: `npm run eval:export-replays` writes them under
  `.discord-ai-agent/evals/`, and they are never committed.
- For prompt or tool changes run `npm run eval -- --repeat 3` and compare
  pass@1 and pass^k with the base revision. Run `npm run eval:replay` against
  production replays when they are available.
- Never make an eval pass with an exact-phrase branch or a prompt line that
  exists only for one case.

## Verification

Run the closest focused check first, then proportionate broad checks:

- TypeScript: `npm run typecheck`; normally finish with `npm run verify`.
- Tool or prompt behavior: focused unit and agent tests, `npm run eval -- --dry-run`
  for eval schema changes, and the eval runs above.
- Native runtime: `cargo fmt --check`, `cargo clippy`, `cargo test` (all with
  `--manifest-path native/nanocodex-runtime/Cargo.toml`), then
  `npx vitest run tests/native` against the built binary.
- Database, payments, queues, RNG, or migrations: `npm run verify:db` plus
  concurrency, idempotency, and upgrade coverage where applicable.
- Console or build work: `npm run build` and focused projection/routing tests.
- Always run `git diff --check`; update the owning guide under `docs/` when an
  owner, invariant, source of truth, or operator workflow changes.

Do not add smoke or end-to-end coverage by default. Add the smallest regression
coverage that proves the failure and the general fix.

## Git and PR Discipline

- Review the exact diff before staging. Never stage unrelated user work.
- Commit, push, or open a PR only when asked.
- Before updating a PR branch, run `gh pr view <number> --json state,mergedAt`.
  A merged PR is immutable: branch from current `origin/main` and open a new PR.
- A PR states user impact, root cause or decision, risk or rollout needs, and
  exact verification. Open a ready-for-review non-draft PR when asked; never
  merge or deploy unless explicitly asked.
