# Architecture

This guide is the system map. It explains the deployed processes, request lifecycles, durable sources of truth, and source ownership. Read [Product](product.md) first when changing a trust boundary or user-visible behavior.

## System shape

The application is TypeScript on Node.js 22 with Postgres, pgvector, Discord, OpenRouter, and the embedded NanoCodex runtime. One executable supports three roles:

| Role | Owns |
| --- | --- |
| `bot` | Discord gateway events, ingress, reactions, delivery, component interactions, deployment announcements, and task notifications |
| `worker` | Agent executions, crawl and embedding jobs, code-update jobs, reconciliation, compaction, and retention |
| `api` | Authenticated control API, sandbox callbacks, metrics, and the run console |

`all` starts all roles for a fully configured single-process environment. Production normally splits them. Chat requires the bot plus a worker with agent-runtime work enabled. Code updates also require task work and the API callback surface.

```text
Discord message
  -> bot persists request and execution
  -> pg-boss job
  -> worker resumes NanoCodex session and executes tools
  -> durable result and delivery manifest
  -> bot/worker delivery path posts one final reply

Code-change tool call
  -> durable agent task
  -> isolated Kubernetes Job
  -> verify and release scan
  -> GitHub branch and PR
  -> Discord task message reaches a terminal state
```

`src/index.ts` wires roles and dependencies. `src/config/env.ts` is the canonical configuration schema. `src/jobs/queue.ts` registers recurring and queued work.

## Architectural invariants

- NanoCodex is the only agent engine. Chat runs in the application; only repository changes enter a sandbox.
- `agent_runtime_*` is the canonical execution ledger for chat and code-update attempts.
- Discord delivery obligations describe what still needs to be rendered; they are not a second execution ledger.
- The model receives one stable tool schema narrowed only by each contract's declarative deployment-availability predicate. It chooses tools directly.
- `src/agent/` is capability-agnostic. Installed product behavior enters through the capability session, tool contracts, and tool handlers rather than feature imports or tool-name branches in the model loop.
- Every tool call is revalidated against its canonical schema, current deployment, requester scope, and access policy.
- The current requester and current-turn intent are immutable authority.
- Postgres owns durable state. In-memory values may cache or coordinate but cannot become an alternate source of truth.
- Migrations are forward-only. Fresh installs apply `migrations/001_initial.sql` and every later numbered migration.
- Private community content belongs in Postgres or `.discord-ai-agent/`, never tracked source.

## Chat lifecycle

1. `src/discord/client.ts` wires Discord events. `messageIngress.ts` and `turnPreparation.ts` decide whether to respond, persist the message, resolve reply context, and create the runtime session/execution.
2. `src/agent/runtimeEnvelope.ts` stores a replayable, requester-scoped turn envelope and input artifact. `runtimeControlPlane.ts` enqueues the execution.
3. `src/discord/agentRuntimeRunner.ts` composes Discord delivery and installed feature services around the generic executor; `runtimeExecutor.ts` invokes the agent runtime.
4. `src/capabilities/catalog.ts` is the installation manifest: it groups each tool contract and handler under a product capability and declares optional per-turn hooks. Optional contracts own their configuration predicate through `available`; there is no central feature-name switch. `src/capabilities/index.ts` prepares hooks into one capability session.
5. `nanocodexAgentRuntime.ts` consumes only that generic session, builds the prompt, resumes a compatible opaque NanoCodex snapshot, exposes the deployment tool contract, and handles model/tool events.
6. `toolDispatcher.ts` validates and gates the selected local tool, then dispatches through focused adapters in `src/tools/handlers/`.
7. Tools write files, tables, footers, or semantic Discord presentation to one turn output. Successful mutations are retained so a later model failure or timeout can still return the committed result.
8. Runtime messages, events, artifacts, usage, and the next NanoCodex snapshot are stored in the canonical ledger.
9. `src/discord/agentDelivery.ts` records a versioned delivery intent. `presentationDelivery.ts` and `responseSink.ts` render the final content, files, Components V2 payload, and cleanup. Startup sweeps replay incomplete obligations idempotently.

Prompts sharing a Discord thread key are serialized; different keys may execute concurrently. A loading reaction is delivery state, not a provisional textual answer.

## Retrieval and memory lifecycle

1. Gateway persistence and `src/discord/crawler.ts` store bot-visible guild, channel, member, message, reaction, and attachment state.
2. Embedding jobs fill the fixed-dimension pgvector index asynchronously. Lexical retrieval works before embeddings are complete.
3. `src/db/retrievalRepository.ts` applies visible-channel, author, channel, thread, and date constraints before returning candidates.
4. `src/memory/` and the Discord retrieval tools expose bounded lexical, semantic, recent-context, stats, summary, and attachment primitives.
5. Conversation messages and compacted snapshots provide per-thread continuity to `promptBuilder.ts`; they never widen requester permissions.

The data lifecycle is the first place to fix missing or stale Discord knowledge. Prompt wording cannot repair content that was never persisted, embedded, permission-filtered, or returned.

## Code-update lifecycle

1. The model selects `runCodingAgent` for an explicit request to change the repository, fix CI, inspect a PR, or repair a prior task.
2. `src/tools/agentTaskTools.ts` creates the task projection and a task-linked runtime execution.
3. `src/jobs/agentTaskEnqueue.ts` performs the atomic queue handoff.
4. `src/execution/backend.ts` creates one isolated Kubernetes Job with task-scoped configuration and credentials.
5. `runnerPipeline.ts` prepares a cached mirror and isolated worktree, builds a focused context pack, runs NanoCodex with workspace tools, refreshes dependencies when manifests change, verifies, scans, pushes an allowed branch, and opens or updates a PR.
6. Sandbox callbacks and command summaries become `agent.task.*` runtime events. Task rows remain projections used for status and Discord rendering.
7. Reconcilers turn lost workers, missing Jobs, and absent terminal callbacks into explicit terminal states and cleanup.

See [Code updates](code-updates.md) for publication and sandbox details.

## Sources of truth

| State | Canonical owner |
| --- | --- |
| Agent sessions, executions, transcript, events, artifacts, snapshots | `src/db/agentRuntimeRepository.ts` and `agentRuntimeArtifactRepository.ts` |
| Discord archive, attachments, aliases, exclusions, crawl cursors | Focused repositories under `src/db/`, especially `discordArchiveRepository.ts` |
| Retrieval and aggregates | `retrievalRepository.ts`, `retrievalAttachmentRepository.ts`, and `retrievalStatsRepository.ts` |
| Conversation continuity | `conversationMemoryRepository.ts` and `conversationCompaction.ts` |
| Pending final rendering | `deliveryObligationsRepository.ts` |
| Code-update task projection and reads | `agentTaskRepository.ts` and focused task read repositories |
| Wallets, transfers, wagers, receipts | `paymentRepository.ts`, `paymentOperationsRepository.ts`, and focused payment/service modules |
| Random sessions and draws | `rngRepository.ts` |
| Server prompt overlays | `serverOverlayRepository.ts` |
| Per-guild agent model selection | `agentSettingsRepository.ts` |

`src/db/repositories.ts` composes the focused repository functions with one pool. It contains only cross-repository lifecycle coordination; SQL stays in the focused owner.

## Source ownership

| Area | Main entry points | Closest verification |
| --- | --- | --- |
| Generic prompt and NanoCodex execution | `src/agent/capabilityRuntime.ts`, `nanocodexAgentRuntime.ts`, `promptBuilder.ts` | architecture, NanoCodex runtime, prompt, and agent integration tests |
| Installed capability lifecycle and feature orchestration | `src/capabilities/` | focused capability tests plus architecture boundary tests |
| Tool contract and dispatch | `src/capabilities/catalog.ts`, `toolContracts.ts`, `src/tools/contracts/`, `src/tools/handlers/` | capability-catalog, registry, contract-validation, handler-conformance tests |
| Discord ingress and delivery | `src/discord/client.ts`, `messageIngress.ts`, `agentDelivery.ts`, `responseSink.ts` | Discord client/delivery/response-sink tests |
| Discord data and retrieval | `src/discord/crawler.ts`, `src/db/*Repository.ts`, `src/memory/`, retrieval tools | crawler/search/tool tests and DB integration tests |
| Control plane and console | `src/control/internalApiServer.ts`, `src/control/`, `src/control/console/` | internal API, observability, and console tests |
| Queue ownership | `src/jobs/queue.ts`, `agentTaskEnqueue.ts` | queue unit tests and `tests/integration/jobs-db.test.ts` |
| Code-update execution | `src/execution/backend.ts`, `runnerPipeline.ts`, `repoWorkspace.ts` | sandbox runner, backend, callback, and task tests |
| Payments and games | `src/payments/`, `src/tools/walletTools.ts`, `randomTools.ts`, `standardWager*` | focused wallet/RNG tests and DB integration tests |
| Configuration and startup | `src/config/env.ts`, `src/index.ts`, `.env.example` | config, startup, preflight, and Helm tests |

## Observability

Important model, tool, provider, queue, sandbox, mutation, and delivery transitions are typed events. `runtimeEventSchema.ts` maps registered event namespaces and terminal segments to controlled category/phase dimensions; exceptional events may provide an explicit phase, while unknown names stay `system/progress` rather than being guessed from words embedded in a name. Large or sensitive details are retained as redacted artifacts rather than event metadata. The console, `runs:inspect`, `discord:debug`, task status, and metrics all project the same underlying ledger. Quality metrics group answer latency/cost/status by model and deployed revision, tool outcomes by typed status, reviewed feedback by failure mode, and recovered deliveries.

Observability may expose model inputs/outputs and deterministic decisions after permission checks and redaction. It never claims to expose private chain of thought.

## Overlay boundary

Tracked source ships neutral defaults. Deployment-specific persona and instructions live in `.discord-ai-agent/prompt-overlay.md` or a Postgres server overlay. Private eval prompts live in `.discord-ai-agent/evals/`. Indexed messages, aliases, member data, bug markers, and traces live in Postgres. `npm run scan:release` enforces the public/private boundary.
