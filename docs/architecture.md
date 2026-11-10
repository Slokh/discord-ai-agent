# Architecture

This guide is the system map: the deployed processes, how a request moves, where durable state lives, and which modules own it. Read [Product](product.md) first when changing a trust boundary or user-visible behavior.

## System shape

The application is TypeScript on Node.js 22 with Postgres and pgvector, Discord, OpenRouter, and one native nanocode host process. One executable supports four process roles, selected by the first matching argument to `src/index.ts`:

| Role | Owns |
| --- | --- |
| `bot` | Discord gateway events, ingress, message persistence, loading reactions, final delivery, and the startup delivery sweep |
| `worker` | Agent executions (including the nanocode host), crawl jobs, stale-execution reconciliation, conversation compaction, retention, and payment reconciliation |
| `console` | The read-only operator Console and its health probe |
| `all` | Every role in one process |

Chat requires a bot and a worker. The Console reads Postgres and starts no queues, gateway, models, or mutation capabilities.

```text
Discord message
  -> bot persists the message, turn envelope, execution, and delivery obligation
  -> pg-boss job agent.runtime.execution
  -> worker steers it into the requester's running turn, or runs it in its thread queue
  -> nanocode host runs the turn in the requester's durable session
  -> application tools execute in Node with permission gates
  -> delivery intent persisted, then posted to Discord as one reply
```

`src/runtime/applicationServices.ts` is the composition root for repositories, model access, randomness, payments, and delivery state; production and the local prompt runner (`npm run prompt`) consume the same services. `src/config/env.ts` is the configuration schema and holds versioned `productConfig`. `src/jobs/queue.ts` registers queued and recurring work.

## Architectural invariants

- nanocode is the only agent engine. Every chat turn runs in the worker's nanocode host.
- `agent_runtime_*` is the execution ledger for chat and durable background jobs. nanocode's own session store (Postgres schema `nanocode`) holds model conversation state, not execution history.
- Discord delivery obligations describe what still needs to be rendered; they are not a second execution ledger.
- Service heartbeats are an expiring liveness projection, not event history.
- The model receives one tool list, `TOOL_NAMES_BY_CAPABILITY` in `src/tools/toolDefinition.ts`, narrowed only by each contract's `available` predicate.
- `src/agent/` is capability-agnostic. Product behavior enters through capability sessions, tool contracts, and tool handlers, never feature imports or tool-name branches in the model loop.
- Every tool call is revalidated against its canonical schema, current deployment, requester scope, and access policy.
- The current requester and current-turn intent are immutable authority.
- Postgres owns durable state. In-memory values may cache or coordinate but are never an alternate source of truth.
- Migrations are forward-only. Fresh installs apply `migrations/001_initial.sql` and every later numbered migration.
- Private community content belongs in Postgres or `.discord-ai-agent/`, never tracked source.

Architecture tests (`tests/unit/architecture.test.ts`) enforce source and test size budgets, acyclic relative imports, the generic-agent boundary, contract-to-handler direction, centralized environment access, and the presence of these guides.

## Chat lifecycle

1. `src/discord/client.ts` wires gateway events. `messageIngress.ts` decides whether to respond, persists the message, adds the loading reaction, and calls `turnPreparation.ts`, which resolves reply context, prior conversation messages, and visible channels into a requester-scoped turn envelope (`src/agent/runtimeEnvelope.ts`). The Discord message ID is the request ID for the whole turn.
2. `src/agent/runtimeLifecycle.ts` enqueues the execution.
3. In the worker, `src/jobs/queue.ts` offers each job to `steerFollowUp` (`src/discord/agentRuntimeRunner.ts`). When the same requester already has a running turn in that channel, the follow-up is steered into it, its own execution and delivery obligation close, and the message gets `👀`. Other jobs run serially per channel or thread key and concurrently across keys.
4. `src/discord/agentDelivery.ts` loads the envelope; `src/agent/runtimeExecutor.ts` runs `nanocodexAgentRuntime.ts` with the installed capability session (`src/capabilities/`).
5. `nanocodexAgentRuntime.ts` builds the session prompt, loads inline images, derives the session key, records the session mapping, and calls the shared nanocode host. [Agent system](agent-system.md) describes the session and host contracts.
6. Tool calls return to Node, where `toolDispatcher.ts` validates and gates them and dispatches to `src/tools/handlers/`. Tools write files, tables, and footer lines to the turn output. Successful mutations are retained so a later model failure can still return the committed result.
7. `agentDelivery.ts` records a versioned delivery intent and posts it through `responseSink.ts`. The bot's startup sweep (`deliverySweep.ts`) replays unfinished obligations idempotently. The worker's reconciler (`src/agent/runtimeReconciler.ts`) fails executions that stopped progressing for 15 minutes instead of leaving phantom work running.

## Retrieval and memory lifecycle

1. Gateway persistence and `src/discord/crawler.ts` store bot-visible guild, channel, member, message, reaction, and attachment state. The worker runs a daily crawl.
2. Ingress enqueues new messages for embedding. The embedding consumer is off in the standard worker; `npm run embeddings:worker` or `npm run embeddings:backfill` fills the pgvector index. Lexical retrieval works without embeddings.
3. `src/db/retrievalRepository.ts` applies visible-channel, author, channel, thread, and date constraints before returning candidates.
4. `src/memory/` and the Discord retrieval tools expose bounded lexical, semantic, recent-context, stats, summary, and attachment primitives.
5. Conversation messages and compacted snapshots (`conversationMemoryRepository.ts`, `conversationCompaction.ts`) feed the bootstrap context of a new nanocode session; they never widen requester permissions.

The data lifecycle is the first place to fix missing or stale Discord knowledge. Prompt wording cannot repair content that was never persisted, embedded, permission-filtered, or returned.

## Sources of truth

| State | Canonical owner |
| --- | --- |
| Executions, runtime sessions, transcript, events, artifacts | `src/db/agentRuntimeRepository.ts`, `agentRuntimeArtifactRepository.ts` |
| nanocode model sessions | nanocode's `SqlStore` in schema `nanocode` (`native/nanocodex-runtime/src/store.rs`); requester mapping in `nanocodeSessionRepository.ts` |
| Discord archive, attachments, aliases, exclusions, crawl cursors | `discordArchiveRepository.ts` and focused repositories under `src/db/` |
| Retrieval and aggregates | `retrievalRepository.ts`, `retrievalAttachmentRepository.ts`, `retrievalStatsRepository.ts` |
| Conversation continuity | `conversationMemoryRepository.ts`, `conversationCompaction.ts` |
| Pending final rendering | `deliveryObligationsRepository.ts` |
| Verified release promotion | `deploymentVerificationRepository.ts` |
| Wallets, transfers, wagers, receipts | `paymentRepository.ts`, `paymentOperationsRepository.ts`, and focused payment modules |
| Random sessions and draws | `rngRepository.ts` |
| Server prompt overlays | `serverOverlayRepository.ts` |
| Typed per-user preferences | `userPreferenceRepository.ts` plus capability-owned key validators |
| Process liveness and Console projections | `serviceHeartbeatRepository.ts`, `operatorDashboardRepository.ts`, `src/console/` |

`src/db/repositories.ts` composes the focused repository functions over one pool and coordinates only cross-repository lifecycles such as privacy deletion; SQL stays in the focused owner.

## Source ownership

| Area | Main entry points | Closest verification |
| --- | --- | --- |
| Agent turn and nanocode host | `src/agent/nanocodexAgentRuntime.ts`, `nanocodeHost.ts`, `sharedNanocodeHost.ts`, `promptBuilder.ts`, `native/nanocodex-runtime/` | `tests/unit/nanocodex-agent-runtime.test.ts`, `tests/native/`, Rust unit tests |
| Installed capabilities | `src/capabilities/` | capability-catalog tests plus architecture boundary tests |
| Tool contracts and dispatch | `src/tools/toolDefinition.ts`, `src/capabilities/catalog.ts`, `toolContracts.ts`, `src/tools/contracts/`, `src/tools/handlers/` | tool-registry, contract-validation, and capability-catalog tests |
| Discord ingress and delivery | `src/discord/client.ts`, `messageIngress.ts`, `agentRuntimeRunner.ts`, `agentDelivery.ts`, `responseSink.ts` | Discord client, delivery, and response-sink tests; `npm run test:reliability` |
| Discord data and retrieval | `src/discord/crawler.ts`, `src/db/*Repository.ts`, `src/memory/`, retrieval tools | crawler, search, and tool tests; DB integration tests |
| Queue ownership | `src/jobs/queue.ts` | queue unit tests and `tests/integration/jobs-db.test.ts` |
| Payments and games | `src/payments/`, `src/tools/walletTools.ts`, `randomTools.ts`, `randomWagerTools.ts`, `standardWager*` | wallet and RNG tests; `npm run verify:db` |
| Operator Console | `src/console/`, `src/db/operatorDashboardRepository.ts`, `src/runtime/serviceHeartbeat.ts` | Console unit tests and dashboard DB projection tests |
| Configuration and startup | `src/config/env.ts`, `src/config/environment.ts`, `src/index.ts`, `.env.example` | config, startup, preflight, and Helm tests |
| Evals | `scripts/eval.ts`, `scripts/evalJudge.ts`, `scripts/exportReplayCases.ts`, `evals/prompts/` | `tests/unit/eval-runner.test.ts` |
| Release | `scripts/deployK3s.sh`, `scripts/markReleaseVerified.ts`, `.github/workflows/` | architecture and workflow tests |

Entry points do not reconstruct application services independently. Add a durable repository or provider once in `src/runtime/applicationServices.ts`, then pass it to the role-specific adapter.

## Observability

Important model, tool, provider, queue, mutation, and delivery transitions are typed runtime events. `src/observability/runtimeEventSchema.ts` maps registered event namespaces to controlled category and phase dimensions; unknown names stay `system/progress` rather than being guessed. Large or sensitive details are retained as redacted artifacts, not event metadata.

nanocode host events are recorded as `agent.nanocodex.*` events with normalized token usage (`src/agent/nanocodexUsage.ts`). Completion events record the session contract hash, so a prompt-cache miss after a deploy can be traced to a contract change. Tool completion events retain stable error codes, retryability, the contract's latency budget, and whether a successful call exceeded it.

Observability may expose model inputs and outputs and deterministic decisions after permission checks and redaction. It never claims to expose private chain of thought.

## Overlay boundary

Tracked source ships neutral defaults. Deployment-specific persona and instructions live in `.discord-ai-agent/prompt-overlay.md` or a Postgres server overlay. Private eval cases live in `.discord-ai-agent/evals/`. Indexed messages, aliases, member data, and runtime records live in Postgres. `npm run scan:release` enforces the public/private boundary.
