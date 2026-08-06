# Architecture

This guide is the system map. It explains the deployed processes, request lifecycles, durable sources of truth, and source ownership. Read [Product](product.md) first when changing a trust boundary or user-visible behavior.

## System shape

The application is TypeScript on Node.js 22 with Postgres, pgvector, Discord, OpenRouter, and the embedded NanoCodex runtime. One executable supports three roles:

| Role | Owns |
| --- | --- |
| `bot` | Discord gateway events, ingress, reactions, delivery, component interactions, deployment announcements, and task notifications |
| `worker` | Agent executions, crawl and embedding jobs, reminder and scheduled-request delivery, code-update jobs, reconciliation, compaction, and retention |
| `api` | Internal signed sandbox callbacks and health probe |

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

Schedule tool call
  -> durable requester-owned notification or read-only-agent recurring-series row
  -> delayed pg-boss wakeup or reconciliation
  -> atomic delivery claim and current permission check
  -> literal nonce-deduplicated notification
     OR canonical scheduled NanoCodex execution with non-mutating tools only
  -> nonce-deduplicated Discord delivery
  -> delivered message identity committed to Postgres
  -> recurring series atomically advances and enqueues its next wakeup

Reply to a schedule delivery
  -> exact direct-parent delivery identity plus immutable requester scope
  -> atomic cancel, pause, resume, or schedule/recurrence replacement
  -> obsolete delayed wakeups fail the current due-time claim
```

`src/index.ts` selects process roles and starts adapters. `src/runtime/applicationServices.ts` is the shared composition root for repositories, model access, randomness, payments, and delivery state; production and the local prompt runner consume the same services. `src/config/env.ts` is the canonical configuration schema. `src/jobs/queue.ts` registers recurring and queued work.

Large entry points remain coordinators. Focused mechanics live beside them: keyed serialization and embedding priority under `src/jobs/`, OpenRouter response/error normalization under `src/models/`, and sandbox callbacks and private bug-regression validation under `src/execution/`. Architecture tests enforce source/test size budgets, acyclic imports, the generic-agent boundary, contract/handler direction, and centralized production environment access.

## Architectural invariants

- NanoCodex is the only agent engine. Chat runs in the application; only repository changes enter a sandbox.
- `agent_runtime_*` is the canonical execution ledger for chat, code-update attempts, and durable background jobs.
- Discord delivery obligations describe what still needs to be rendered; they are not a second execution ledger.
- The model receives one stable tool schema narrowed only by each contract's declarative deployment-availability predicate. It chooses tools directly.
- `src/agent/` is capability-agnostic. Installed product behavior enters through the capability session, tool contracts, and tool handlers rather than feature imports or tool-name branches in the model loop.
- Every tool call is revalidated against its canonical schema, current deployment, requester scope, and access policy.
- The current requester and current-turn intent are immutable authority.
- Postgres owns durable state. In-memory values may cache or coordinate but cannot become an alternate source of truth. Repository queries apply status, channel, revision, and time filters before limits, with partial recent-execution indexes keeping the path bounded.
- Migrations are forward-only. Fresh installs apply `migrations/001_initial.sql` and every later numbered migration.
- Member-visible release actions require the deployed SHA and unique rollout ID's durable verification marker; pod readiness alone does not promote a release.
- Private community content belongs in Postgres or `.discord-ai-agent/`, never tracked source.

## Chat lifecycle

1. `src/discord/client.ts` wires Discord events. `messageIngress.ts` and `turnPreparation.ts` decide whether to respond, persist the message, resolve reply context, and create the runtime session/execution.
2. `src/agent/runtimeEnvelope.ts` stores a replayable, requester-scoped turn envelope and input artifact. `runtimeLifecycle.ts` enqueues the execution.
3. `src/discord/agentRuntimeRunner.ts` composes Discord delivery and installed feature services around the generic executor; `runtimeExecutor.ts` invokes the agent runtime.
4. `src/capabilities/catalog.ts` is the installation manifest: it groups each tool contract and handler under a product capability and declares optional per-turn hooks. Optional contracts own their configuration predicate through `available`; there is no central feature-name switch. `src/capabilities/index.ts` prepares hooks into one capability session.
5. `nanocodexAgentRuntime.ts` consumes only that generic session, builds the prompt, resumes a compatible opaque NanoCodex snapshot, exposes the deployment tool contract, and handles model/tool events.
6. `toolDispatcher.ts` validates and gates the selected local tool, then dispatches through focused adapters in `src/tools/handlers/`.
7. Tools write files, tables, footers, or semantic Discord presentation to one turn output. Successful mutations are retained so a later model failure or timeout can still return the committed result.
8. Runtime messages, events, artifacts, usage, and the next NanoCodex snapshot are stored in the canonical ledger.
9. `src/discord/agentDelivery.ts` records a versioned delivery intent. `presentationDelivery.ts` and `responseSink.ts` render the final content, files, Components V2 payload, and cleanup. Startup sweeps replay incomplete obligations idempotently. The worker also terminalizes non-task executions that remain queued/running beyond the bounded execution window, recording a typed stale-reconciliation failure instead of leaving phantom work active.

On release startup, the bot waits for the deployment workflow's Postgres promotion marker before retrying repaired bug prompts or announcing the revision. Failed verification and rollback candidates never cross that member-visible boundary.

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
| Verified release promotion and deployment announcements | `deploymentAnnouncementRepository.ts` |
| Code-update task projection and reads | `agentTaskRepository.ts` and focused task read repositories |
| Wallets, transfers, wagers, receipts | `paymentRepository.ts`, `paymentOperationsRepository.ts`, and focused payment/service modules |
| Random sessions and draws | `rngRepository.ts` |
| Server prompt overlays | `serverOverlayRepository.ts` |
| Per-guild agent model selection | `agentSettingsRepository.ts` |
| Typed per-user preferences | `userPreferenceRepository.ts` plus capability-owned key validators |
| Scheduled notification/agent state, claims, and delivery identity | `reminderRepository.ts` and `src/reminders/` |
| Unified improvement lifecycle | `improvementRepository.ts`, `improvementWorkRepository.ts`, `improvementVerificationRepository.ts`, and `src/improvements/` |

`src/db/repositories.ts` composes the focused repository functions with one pool. It contains only cross-repository lifecycle coordination; SQL stays in the focused owner.

## Source ownership

| Area | Main entry points | Closest verification |
| --- | --- | --- |
| Generic prompt and NanoCodex execution | `src/agent/capabilityRuntime.ts`, `nanocodexAgentRuntime.ts`, `promptBuilder.ts` | architecture, NanoCodex runtime, prompt, and agent integration tests |
| Installed capability lifecycle and feature orchestration | `src/capabilities/` | focused capability tests plus architecture boundary tests |
| Tool contract and dispatch | `src/capabilities/catalog.ts`, `toolContracts.ts`, `src/tools/contracts/`, `src/tools/handlers/` | capability-catalog, registry, contract-validation, handler-conformance tests |
| Improvement signal intake and lifecycle | `src/tools/contracts/improvements.ts`, `src/tools/handlers/improvements.ts`, `src/discord/improvementReaction.ts`, `src/db/improvementRepository.ts` | domain, handler-conformance, reaction, and DB integration tests |
| Improvement automation, proof routing, and receipts | `src/improvements/reconciler.ts`, `proofAdapters.ts`, `verification.ts`, and the focused improvement repositories | reconciler, improvement verification, queue, workflow, and DB integration tests |
| Discord ingress and delivery | `src/discord/client.ts`, `messageIngress.ts`, `agentDelivery.ts`, `responseSink.ts` | Discord client/delivery/response-sink tests |
| Discord data and retrieval | `src/discord/crawler.ts`, `src/db/*Repository.ts`, `src/memory/`, retrieval tools | crawler/search/tool tests and DB integration tests |
| Sandbox callback receiver | `src/execution/callbackServer.ts`, `src/execution/callbacks.ts` | sandbox callback tests |
| Queue ownership | `src/jobs/queue.ts`, `agentTaskEnqueue.ts` | queue unit tests and `tests/integration/jobs-db.test.ts` |
| Schedule lifecycle | `src/tools/contracts/reminders.ts`, `src/tools/reminderTools.ts`, `src/db/reminderRepository.ts`, `src/reminders/reminderDelivery.ts`, `scheduledAgentExecution.ts`, `src/jobs/reminderJobs.ts` | schedule tool/delivery/execution tests and reminder/jobs DB integration tests |
| Code-update execution | `src/execution/backend.ts`, `runnerPipeline.ts`, `repoWorkspace.ts` | sandbox runner, backend, callback, and task tests |
| Payments and games | `src/payments/`, `src/tools/walletTools.ts`, `randomTools.ts`, `randomWagerTools.ts`, `standardWager*` | focused wallet/RNG tests and DB integration tests |
| Configuration and startup | `src/config/env.ts`, `src/index.ts`, `.env.example` | config, startup, preflight, and Helm tests |
| Release evidence | `scripts/releaseStatus.ts`, revision quality, GitHub workflows, Helm/Kubernetes state | release-status, revision-quality, workflow, and post-deploy canary tests |

Entrypoints must not reconstruct application-owned services independently. Add a durable repository or provider once in `src/runtime/applicationServices.ts`, then pass the composed dependency to the role-specific adapter. Test doubles remain local to tests.

## Observability

NanoCodex provider-call tokens are normalized into the canonical usage fields, while its terminal turn event owns the aggregate cost estimate used by spend projections so costs are not double-counted. Tool completion events retain stable error codes and retryability. Revision health uses the final result for each capability within a member execution while separately reporting total attempts and recovered argument-validation retries. `src/observability/runtimeVersions.ts` owns the behavior-cohort identity used to compare production quality across compatible revisions; incompatible execution or delivery semantics require an explicit quality-runtime version bump.

Important model, tool, provider, queue, sandbox, mutation, and delivery transitions are typed events. `runtimeEventSchema.ts` maps registered event namespaces and terminal segments to controlled category/phase dimensions; exceptional events may provide an explicit phase, while unknown names stay `system/progress` rather than being guessed from words embedded in a name. Large or sensitive details are retained as redacted artifacts rather than event metadata. The canonical ledger remains in Postgres for trusted operational investigation. Statistical quality metrics group answer latency/status, tool outcomes, and improvement-signal rates by behavior cohort, while hard execution and delivery evidence remains exact-revision; cost projections retain their own model/revision dimensions.

Every prompt execution declares a quality cohort. Member-originated Discord turns are `member`, due-time read-only agent occurrences are `scheduled`, and CLI, evaluation, and deployment probes are `synthetic`. Revision health, baselines, tool outcomes, and delivery alerts use only the member cohort; improvement rates separately use signals attributed to the deployed revision. Scheduled executions retain normal typed runtime and cost evidence without distorting member-answer quality. `agent_runtime_*` is the occurrence-history source of truth; `scheduled_reminders` projects latest health and automatic-pause control state instead of duplicating that history.

Observability may expose model inputs/outputs and deterministic decisions after permission checks and redaction. It never claims to expose private chain of thought.

## Overlay boundary

Tracked source ships neutral defaults. Deployment-specific persona and instructions live in `.discord-ai-agent/prompt-overlay.md` or a Postgres server overlay. Private eval prompts live in `.discord-ai-agent/evals/`. Indexed messages, aliases, member data, improvement cases, and canonical runtime records live in Postgres. `npm run scan:release` enforces the public/private boundary.
