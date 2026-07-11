# Continuation Plan

This plan follows the completed pre-release hardening checklist. It is the working foundation plan for continued product development.

## Operating targets

- Ordinary chat p95: under 8 seconds.
- Discord acknowledgement p95: under 1 second.
- Keyword history search p95: under 1 second.
- Hybrid history search p95: under 3 seconds.
- Semantic-search degradation: under 1% of history searches.
- Model-call accounting: 100% of calls include purpose, model, latency, token usage, cache usage, finish reason, and estimated cost when the provider returns it.
- Delivery recovery: zero terminal executions left with pending delivery obligations after reconciliation.
- Test isolation: zero application rows left in the developer database by DB-backed tests.

## Current foundation work

- [x] Add one observed model-call telemetry contract for routing, synthesis, and recovery calls.
- [x] Add prompt/tool-schema byte counts, fingerprints, offered tools, token/cache use, cost, latency, and outcome metadata.
- [x] Add a dedicated console Models view with per-call and aggregate usage.
- [x] Split the default 11-tool core scope into minimal core, generated-data, and Discord-action scopes.
- [x] Run keyword and semantic history retrieval concurrently.
- [x] Avoid a full Discord channel refresh on every prompt.
- [x] Add atomic per-user chat-turn reservations.
- [x] Add terminal runtime-session retention.
- [x] Replace raw-password UI cookies with derived session tokens.
- [x] Add real console stream polling/reconnect fallback.
- [x] Split slim runtime and codegen container targets and run them as a non-root user.
- [x] Add Helm resource and security defaults plus missing runtime settings.
- [x] Add deployed Git revision identifiers to sessions and model-call events.
- [x] Validate versioned model-call events at the runtime repository boundary.
- [x] Use reciprocal-rank fusion for hybrid retrieval.
- [x] Parallelize independent same-round read-only tools.
- [x] Emit only changed run snapshots on the console stream, with lightweight heartbeats.
- [x] Add aggregate audited cost and active-session metrics.

## Next implementation slices

### Typed runtime trace

- [x] Expand the versioned model-call schema into a discriminated union for ingress, context, model, tool, retrieval, delivery, task, and system events.
- [x] Validate versioned model-call events at the repository write boundary.
- [x] Prefer typed event categories and phases in the console, retaining name inference only for pre-migration rows.
- [x] Add first-class `span_id` and `parent_span_id` columns.
- [x] Make trace, tool-audit, and metric views explicit projections of runtime events.

### Console modularization

- [x] Move run inbox, overview, terminal, artifacts, raw, dashboard, comparison, and feedback views into focused modules.
- [x] Move timeline normalization and grouping entirely out of React components.
- [x] Split the stylesheet by shell, timeline, terminal/artifacts, feedback, comparison, and model calls; remove the duplicate theme override block.
- [x] Stop resending unchanged full snapshots and use lightweight stream heartbeats.
- [x] Replace changed-snapshot polling with incremental runtime events and run-version updates.
- [x] Add Playwright coverage for multi-round chat, recovery, stream reconnect, artifacts, feedback, comparison, and responsive layout.
- [x] Add aggregate dashboards and side-by-side run comparison.

### Latency and retrieval

- [x] Add child spans for keyword SQL, query embedding, vector SQL, and merge/ranking.
- [x] Use reciprocal-rank fusion rather than adding raw keyword and cosine scores.
- [x] Add result diversity and local reranking for difficult history questions.
- [x] Replace the filtered exact vector path with permission-safe ANN candidate escalation.
- [x] Add configurable prompt concurrency with serialization by Discord thread key.
- [x] Parallelize independent read-only tool calls selected in the same model round.

### Operations and quality

- [x] Expand the new audited-cost/session metrics with runtime latency, cache, token, cost, and error histograms.
- [x] Add run feedback and private eval-case capture.
- [x] Add Git revision identifiers to every Discord session and observed model call.
- [x] Add stable prompt/tool/config version identifiers to every execution.
- [x] Add changed-file coverage enforcement and DB-backed coverage reporting.
- [x] Add migration-upgrade tests from the previous released schema.
- [x] Add SBOM generation and fixed-vulnerability container scanning.

## Development rule

New features should include their typed trace events, console rendering, cost/latency accounting, focused tests, and private-eval guidance in the same change. Avoid adding another compatibility projection or regex-based console classification.
