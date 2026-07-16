# Database Domain

Owns durable Postgres state and query contracts.

## Responsibilities

- Discord guilds, channels, users, messages, attachments, edits/deletes, aliases, crawl cursors, interaction blocks, and exclusions live in `discordArchiveRepository.ts`.
- Requester-owned Discord bug-marker writes, privacy cleanup, and permission-filtered inbox reads live in `discordBugMarkerRepository.ts`.
- Message embeddings and embedding backlog selection live in `embeddingRepository.ts`.
- Permission-aware retrieval, search, attachment search, and message context live in `retrievalRepository.ts`; stats and topic candidates live in `retrievalStatsRepository.ts`.
- Conversation sessions and per-channel agent memory live in `conversationMemoryRepository.ts`.
- Agent task lifecycle writes live in `agentTaskRepository.ts`; task/status/timeline readers live in `agentTaskReadRepository.ts`; runtime task/event projection readers live in `agentTaskRuntimeReadRepository.ts`.
- Process runs, spans, run events, artifacts, and cleanup live in `processRunRepository.ts`.
- Trace events and tool audit logs live in `auditRepository.ts`.
- Budget/spend reads live in `budgetRepository.ts` and intentionally derive from existing `agent_runtime_executions`, `agent_tasks`, and `tool_audit_logs` rows instead of maintaining separate counters. Per-user turn-limit overrides (`user_budget_overrides`, managed by the `setUserTurnLimit` tool) are the one piece of stored budget state.
- Wallet accounts and guild/network-scoped wallet directory reads, transfer idempotency, wager exposure, and payment runtime health live in `paymentRepository.ts`, with focused transfer SQL helpers in `paymentTransferPersistence.ts` and forward-only migrations.
- Discord delivery obligations for in-flight runtime turns live in `deliveryObligationsRepository.ts` and store only render state, not duplicated execution history.
- DB-backed skills, server overlays, and health checks live in `skillsRepository.ts`.
- `repositories.ts` is a compatibility facade that delegates to the focused modules; shared types live in `types.ts`, with only cross-domain helpers left in `shared.ts`.

## Change Routing

- Storage/indexing/exclusion changes start here, then update crawler/persistence/retrieval callers.
- Retrieval behavior changes usually touch `retrievalRepository.ts` or `retrievalStatsRepository.ts` plus `src/memory/search.ts`.
- Agent-runtime/task/run-console persistence changes usually touch `agentRuntimeRepository.ts`, `agentTaskRepository.ts`/`agentTaskReadRepository.ts`/`agentTaskRuntimeReadRepository.ts`, `processRunRepository.ts`, plus `src/observability/runs.ts`.

## Scaling Notes

- Filtered vector search currently takes the filtered branch in `retrievalRepository.ts`, which gathers a permission/date/channel-filtered candidate set before ranking by vector distance. That branch bypasses the IVFFLAT index on `message_embeddings.embedding`; revisit with ANN-first candidate escalation or an HNSW index before any deployment approaches roughly 1M indexed messages.

## Tests

- DB-backed behavior: `tests/integration/repository-db.test.ts`.
- Non-DB retrieval helpers: `tests/unit/search.test.ts`.
- Run-console API snapshots: `tests/unit/internal-api-runs.test.ts`.

## Structure

`src/db/repositories.ts` is a compatibility facade; implementation lives in focused modules for messages, retrieval, embeddings, agent runtime sessions, tasks, budget/spend reads, delivery obligations, process runs, and skills. `agentRuntimeRepository.ts` owns the shared `agent_runtime_*` ledger tables: sessions, executions, events, messages, artifacts/chunks, and sandbox leases. Add new queries to the owning focused module, not the facade.
