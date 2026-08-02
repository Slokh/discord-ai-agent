# Database Domain

Owns durable Postgres state and query contracts.

## Responsibilities

- Discord guilds, channels, users, messages, attachments, edits/deletes, aliases, crawl cursors, interaction blocks, and exclusions live in `discordArchiveRepository.ts`.
- Requester-owned Discord bug-marker writes, privacy cleanup, and permission-filtered inbox reads live in `discordBugMarkerRepository.ts`. Durable automated repair state, deployed-revision claims, and exactly-once original-prompt retries live in `discordBugReportRepository.ts`.
- Normalized custom-emoji inline/reaction evidence and per-channel culture profiles live in `discordEmojiUsageRepository.ts`. Evidence is updated when archived messages, edits, deletes, or reactions change; request-time reads use indexed profiles instead of scanning raw message history and remain channel-permission filtered, exclusion-aware, and privacy-deletion safe.
- Message embeddings and embedding backlog selection live in `embeddingRepository.ts`.
- Permission-aware retrieval, search, attachment search, and message context live in `retrievalRepository.ts`; stats and topic candidates live in `retrievalStatsRepository.ts`.
- Conversation sessions and per-channel agent memory live in `conversationMemoryRepository.ts`. Top-level prompt reads are requester-scoped: they include only that member's completed turns and paired assistant/tool records, and exclude channel-wide compacted snapshots.
- Agent task lifecycle writes live in `agentTaskRepository.ts`; task/status/timeline readers live in `agentTaskReadRepository.ts`; runtime task/event projection readers live in `agentTaskRuntimeReadRepository.ts`.
- Process runs, spans, run events, artifacts, and cleanup live in `processRunRepository.ts`.
- Trace events and tool audit logs live in `auditRepository.ts`.
- Durable per-guild NanoCodex model overrides live in `agentSettingsRepository.ts` and `guild_agent_settings`. They are changed only by the configured bot owner or ops allowlist, accept only Sol or Luna, and load before each native request.
- Spend reads live in `budgetRepository.ts` and derive from existing `tool_audit_logs` rows instead of maintaining separate counters. They are observational only; provider account credits are the spend ceiling.
- Wallet accounts, guild/network-scoped wallet directory reads, durable guild starter targets, confirmed transfer-hash history, transfer idempotency, wager exposure, and payment runtime health live in `paymentRepository.ts`, with focused transfer SQL helpers in `paymentTransferPersistence.ts`, starter top-up invariants in `paymentTransferValidation.ts`, active wager reads in `paymentWagerReadRepository.ts`, requester-scoped wager/RNG history in `paymentWagerHistory.ts`, and forward-only migrations.
- Discord delivery obligations for in-flight runtime turns live in `deliveryObligationsRepository.ts` and store only render state, not duplicated execution history. Replayable attachment bytes use `agent_runtime_artifact_blobs`, keyed to normal artifact metadata with cascade cleanup and bounded retention owned by `agentRuntimeArtifactRepository.ts`.
- Opaque requester/channel-scoped component action generations, batch creation, atomic activation/replacement, bounded expiry, and transactional single-use consumption live in `discordComponentActionRepository.ts`; canonical interaction execution remains in `agent_runtime_*`.
- Exactly-once deployment note claims, baselines, and posted Discord message IDs live in `deploymentAnnouncementRepository.ts`.
- Server overlays and database health checks live in `serverOverlayRepository.ts`.
- `repositories.ts` is the application repository surface over focused modules; shared types live in `types.ts`, with only cross-domain helpers left in `shared.ts`.

## Change Routing

- Storage/indexing/exclusion changes start here, then update crawler/persistence/retrieval callers.
- Retrieval behavior changes usually touch `retrievalRepository.ts` or `retrievalStatsRepository.ts` plus `src/memory/search.ts`.
- Agent-runtime/task/run-console persistence changes usually touch `agentRuntimeRepository.ts`, `agentRuntimeArtifactRepository.ts`, `agentTaskRepository.ts`/`agentTaskReadRepository.ts`/`agentTaskRuntimeReadRepository.ts`, `processRunRepository.ts`, plus `src/observability/runs.ts`.

## Scaling Notes

- Vector retrieval starts from the permission-agnostic HNSW `halfvec` candidate set, then applies guild, visible-channel, privacy, author/topic, and date filters. Filtered searches escalate the ANN candidate limit once when the first pass cannot fill the requested result count. At larger scale, measure filtered recall, candidate inflation, `hnsw.ef_search`, and per-guild skew before changing index or partition strategy.

## Tests

- DB-backed behavior: `tests/integration/repository-db.test.ts`.
- Queue/task, migration upgrade, RNG, and payment invariants: `tests/integration/jobs-db.test.ts`, `tests/integration/migration-upgrade-db.test.ts`, `tests/integration/rng-db.test.ts`, and `tests/integration/payments-db.test.ts`.
- Non-DB retrieval helpers: `tests/unit/search.test.ts`.
- Run-console API snapshots: `tests/unit/internal-api-runs.test.ts`.

## Structure

`src/db/repositories.ts` is the application repository surface; implementation lives in focused modules for messages, retrieval, embeddings, agent settings, agent runtime sessions, tasks, budget/spend reads, delivery obligations, process runs, and server overlays. `agentRuntimeRepository.ts` owns shared sessions, executions, events, messages, and sandbox leases; `agentRuntimeArtifactRepository.ts` owns text chunks, binary blobs, integrity metadata, retention, and artifact cleanup behind the same public repository surface. Add new queries to the owning focused module, not the aggregate surface.
