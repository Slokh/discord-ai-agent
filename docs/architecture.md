# Architecture Map

This file is the short map for coding agents. Prefer this and the nearest `src/**/README.md` over rereading the whole repository before making a targeted change.

## Runtime Shape

Discord AI Agent is a TypeScript Node app with three production roles:

- `bot`: Discord gateway, mention detection, response rendering, per-channel conversation memory.
- `worker`: queue consumers for crawl, embeddings, agent runtime executions, code-update tasks, reconciliation, and cleanup.
- `api`: internal control plane for sandbox callbacks, run console APIs, metrics, and authenticated debugging UI.

Postgres is the durable source of truth for Discord messages, embeddings, skills, conversation memory, traces, process runs, task projections, sandbox runs, and the canonical `agent_runtime_*` session/execution/message/event/artifact ledger.

## Core Flows

### Discord Message To Answer

1. `src/discord/client.ts` receives a Discord message and checks whether the bot should respond.
2. The client persists message/edit/delete state, records trace events, creates the durable agent-runtime session/execution with the user transcript message, and stores replayable turn-envelope/input-lines artifacts. Discord chat turns do not create `process_runs` rows.
3. Queued execution loads that turn envelope when available, builds a `ToolContext`, and calls the selected prompt executor. The generic `/api/agent/sessions/:threadKey/execute` endpoint accepts durable `input_lines` artifacts and can enqueue this runtime job when called with Discord delivery context, which lets future chat adapters stay thin and route through the durable session API. Discord ingress and the API share the same `src/agent/runtimeControlPlane.ts` queue-handoff helper so the durable session event stream records `agent.execution.job_enqueued` consistently.
4. `src/agent/router.ts` sends the user request, channel memory, reply context, image context, skills, and tool schemas to the model.
   The first chat message is the large static system prompt so provider prefix caching can reuse it; requester identity, loaded skills, overlays, session memory, reply context, attachments, and the current user request are appended after that stable prefix. `src/models/openrouter.ts` leaves implicit-cache providers alone and adds an Anthropic-only `cache_control` marker to that first system message; `runs:inspect` surfaces `cached_input` from provider usage metadata.
5. The model selects local tools from `src/tools/registry.ts` or OpenRouter-hosted tools.
6. Local tools execute through focused tool-family modules registered in `src/tools/registry.ts`; use `src/tools/README.md` to find the owning module before editing.
7. Every provider call records a versioned `agent.model.call.*` runtime event with purpose, deployed revision, prompt/schema fingerprints and sizes, model, token/cache use, estimated cost, latency, tool selection, and outcome. Tool actions remain separately audited.
8. The router returns the final response/files.
9. `src/discord/responseSink.ts` renders the loading reaction, status message, final reply, attachments, or errors, then the agent-runtime execution is marked terminal.

End state: the canonical execution ledger is the agent-runtime session event stream. Chat turns execute in-process against that ledger; sandboxes are reserved for code-update tasks; Discord-specific code owns delivery obligations (acknowledgements, status edits, final replies, files, and cleanup), not execution state.

### Discord Memory And Retrieval

1. `src/discord/crawler.ts` and incremental message handlers store bot-visible messages and attachment metadata.
2. Embedding workers fill vector data for stored messages.
3. Repository retrieval queries and retrieval tools apply requester-visible channel filters before returning evidence.
4. The agent should prefer broad primitives: exact/semantic history search, recent context, stats, attachment search, generic file inspection, image inspection, and summarization.
5. Generic file inspection permission-checks explicit historical messages against requester-visible indexed channels, refreshes attachment URLs from Discord, performs bounded in-memory parsing without executing content, and records fetch/parser latency as runtime events.

For durable knowledge changes such as excluding a channel, deleting indexed history, changing crawl behavior, embedding eligibility, stats, summaries, or attachment search, start with `src/db/README.md`, `src/discord/README.md`, and `src/memory/` before changing tool descriptions.

### Code Update Request To PR

1. The model calls `runCodingAgent` when the user explicitly asks the bot to update itself or to debug/fix GitHub, CI, PR, deployment, repository, or previous code-update task failures.
2. `src/tools/agentTaskTools.ts` edits the Discord status message with progress, creates the `runCodingAgent` tool message plus task-linked execution in the durable session, and then enqueues the sandbox worker. `src/jobs/agentTaskEnqueue.ts` writes the same canonical runtime records when a caller has not already created them.
3. `src/jobs/agentTaskEnqueue.ts` owns the queue handoff transaction, then `src/jobs/queue.ts` claims the task and launches the configured execution backend.
4. `src/execution/backend.ts` starts either a Kubernetes Job or local process sandbox.
5. `src/execution/sandboxRunner.ts` prepares the repo, prompt, cache, harness config, tests, scan, push, and PR. Use `src/execution/README.md` before changing this path.
6. Sandbox callbacks hit `src/control/internalApi.ts`, which persists command events, artifacts, spans, and terminal output. Worker lifecycle state such as start, warm-lease attachment, sandbox-run attachment, progress, and completion is recorded as `agent.task.*` runtime events.
7. `src/discord/taskNotifications.ts` edits the original Discord status message with current progress and final PR/failure details from canonical `agent.task.*` runtime events. The run console, trace log inspection, and model-facing task-status tool use the same event stream for code-update task progress.

Code-update tasks live in the generic agent runtime. New control-plane work should use `src/db/agentRuntimeRepository.ts` and `/api/agent/sessions/:threadKey` rather than adding codegen-only APIs.

### Run Console And Debugging

1. `src/observability/runs.ts` normalizes process runs, agent-runtime executions/messages/events/artifacts, trace events, tool audits, terminal logs, and task projections. Chat-run console views are derived from runtime executions/events/messages/artifacts; process runs remain for crawler, embedding, and task infrastructure.
2. `src/control/internalApi.ts` exposes `/api/runs`, `/api/runs/:id`, artifact fetch, and streams.
3. `src/control/console/` renders the React run console, including a dedicated Prompt Debugger for provider usage, cost, prompt/tool-schema composition, exact observed request/response captures, tool-round transcripts, and critical-path recommendations per call. Captures use the authenticated artifact API, pass through repository secret redaction, follow runtime artifact retention, and intentionally do not expose private chain-of-thought.
4. `scripts/inspectRun.ts`, `scripts/agentTaskStatus.ts`, and `inspectAgentLogs` are terminal/model-accessible debugging paths.
5. `inspectAgentLogs` accepts Discord message links, message IDs, run IDs, or trace IDs and includes the same normalized run diagnostics as the console when the referenced run is visible to the requester.
6. Worker processes run `src/observability/artifactRetention.ts` periodically to delete expired large process-run and agent-runtime artifacts and their chunks.

Useful terminal entrypoints:

```sh
npm run runs:inspect -- --list --kind codegen --sort slowest --limit 10
npm run runs:inspect -- <run-id-or-discord-message-link> --terminal
npm run tasks:status
```

`runs:inspect` includes model token usage when providers return usage metadata and estimated spend from audited model/tool calls. Use it before digging through raw artifacts when debugging latency or cost.

## Overlay Boundary

The base repo ships neutral defaults. Server-specific content lives outside Git in two overlay homes:

- `.discord-ai-agent/` (gitignored): `prompt-overlay.md` persona/prompt overlay (path via `PROMPT_OVERLAY_PATH`, loaded by `src/agent/promptOverlay.ts` and merged into the system prompt each turn), private eval prompts under `evals/`, skill exports, and local sandbox/codegen caches.
- Postgres: per-guild server overlays (`server_overlays`, loaded in `src/agent/router.ts`), learned skills, user aliases, and all indexed Discord content.

`scripts/scanRelease.ts` enforces the boundary in CI (`npm run scan:release`): tracked files must not contain known-private strings, real-looking Discord snowflakes outside the fixture allowlist, or secret-shaped tokens.

## Change Guidance

- Keep the Discord UX commandless: users should keep writing normal `@ai ...` prompts.
- Prefer improving model-facing tool descriptions, schemas, and outputs over hidden regex branches.
- Keep model-facing tools aligned with the taxonomy/output contracts in `docs/tool-design.md`.
- Keep retrieval permission-aware.
- Keep private server data out of committed fixtures/docs/evals.
- For codegen reliability, improve context packaging, observable progress, and failure classification before changing harnesses.
- For codegen latency, first check first-edit latency, round count, repeated reads, cache state, and prompt/context quality.
- Do not inject long implementation-specific file lists into prompts when a stable domain README or ownership map can guide the agent.
- If a request mentions tool names as part of a product behavior, classify the product behavior first. Tool-name anchors should only dominate when the task is about tool schemas, routing, arguments, or contracts.
- For answer quality, add or update eval prompts before tuning prompts/tools.

For the broader implementation roadmap, see `docs/improvement-plan.md`. For the current pre-release cleanup/hardening checklist, see `docs/pre-release-plan.md`.
