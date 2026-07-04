# Database Domain

Owns durable Postgres state and query contracts.

## Responsibilities

- Discord guilds, channels, users, messages, attachments, edits/deletes, aliases, and exclusions.
- Message embeddings and embedding backlog selection.
- Permission-aware retrieval, stats, topic candidates, attachment search, and message context.
- Conversation sessions and per-channel agent memory.
- Agent runtime sessions, agent tasks, sandbox runs, command events, process runs, run artifacts, traces, and tool audit logs.
- DB-backed skills, server overlays, durable workflows, and health/metrics.

## Change Routing

- Storage/indexing/exclusion changes start here, then update crawler/persistence/retrieval callers.
- Retrieval behavior changes usually touch repository search/stats methods plus `src/memory/search.ts`.
- Agent-runtime/codegen/task/run-console persistence changes usually touch `agentRuntimeRepository.ts`, process-run/task/sandbox sections, plus `src/observability/runs.ts`.

## Tests

- DB-backed behavior: `tests/integration/repository-db.test.ts`.
- Non-DB retrieval helpers: `tests/unit/search.test.ts`.
- Run-console API snapshots: `tests/unit/internal-api-runs.test.ts`.

## Migration Direction

Keep `src/db/repositories.ts` as a compatibility facade. New implementation should move toward focused modules for messages, retrieval, embeddings, agent runtime sessions, tasks, process runs, skills, and workflows. `agentRuntimeRepository.ts` is the generic durable session facade; the current implementation intentionally reuses the existing codegen tables while the Centaur-style runtime migration proceeds.
