# Architecture Map

This file is the short map for coding agents. Prefer this and the nearest `src/**/README.md` over rereading the whole repository before making a targeted change.

## Runtime Shape

Discord AI Agent is a TypeScript Node app with three production roles:

- `bot`: Discord gateway, mention detection, response rendering, per-channel conversation memory.
- `worker`: queue consumers for crawl, embeddings, agent runtime executions, codegen tasks, reconciliation, and cleanup.
- `api`: internal control plane for sandbox callbacks, run console APIs, metrics, and authenticated debugging UI.

Postgres is the durable source of truth for Discord messages, embeddings, skills, conversation memory, traces, process runs, task events, sandbox runs, codegen sessions, and the generic agent-runtime session facade that is replacing codegen-only execution.

## Core Flows

### Discord Message To Answer

1. `src/discord/client.ts` receives a Discord message and checks whether the bot should respond.
2. The client persists message/edit/delete state, creates a run/trace, records the prompt in the durable agent-runtime session ledger, and stores a replayable turn envelope.
3. Queued execution loads that turn envelope when available, builds a `ToolContext`, and calls the selected prompt executor. The generic `/api/agent/sessions/:threadKey/execute` endpoint accepts durable `input_lines` artifacts and can enqueue this runtime job when called with Discord delivery context, which lets future chat adapters stay thin and route through the durable session API. Discord ingress and the API share the same `src/agent/runtimeControlPlane.ts` queue-handoff helper so the durable session event stream records `agent.execution.job_enqueued` consistently.
4. `src/agent/router.ts` sends the user request, channel memory, reply context, image context, skills, and tool schemas to the model.
5. The model selects local tools from `src/tools/registry.ts` or OpenRouter-hosted tools.
6. Local tools execute through the `src/tools/coreTools.ts` facade; use `src/tools/README.md` to find the owning tool-family module before editing.
7. The router records trace events/tool audit rows and returns the final response/files.
8. `src/discord/responseSink.ts` renders the loading reaction, status message, final reply, attachments, or errors, then the agent-runtime execution is marked terminal.

The migration target is Centaur-style execution: Discord ingress appends a turn to the durable agent session, warm Kubernetes sandbox pods run the harness/tool loop, and Discord delivery follows the streamed session events.

### Discord Memory And Retrieval

1. `src/discord/crawler.ts` and incremental message handlers store bot-visible messages and attachment metadata.
2. Embedding workers fill vector data for stored messages.
3. Repository retrieval queries and retrieval tools apply requester-visible channel filters before returning evidence.
4. The agent should prefer broad primitives: exact/semantic history search, recent context, stats, attachment search, image inspection, and summarization.

For durable knowledge changes such as excluding a channel, deleting indexed history, changing crawl behavior, embedding eligibility, stats, summaries, or attachment search, start with `src/db/README.md`, `src/discord/README.md`, and `src/memory/` before changing tool descriptions.

### Code Update Request To PR

1. The model calls `runCodingAgent` when the user explicitly asks the bot to update itself.
2. `src/tools/agentTaskTools.ts` enqueues a durable agent task through the tool facade and edits the Discord status message with progress.
3. `src/jobs/queue.ts` claims the task and launches the configured execution backend.
4. `src/execution/backend.ts` starts either a Kubernetes Job or local process sandbox.
5. `src/execution/sandboxRunner.ts` prepares the repo, prompt, cache, harness config, tests, scan, push, and PR. Use `src/execution/README.md` before changing this path.
6. Sandbox callbacks hit `src/control/internalApi.ts`, which persists command events, artifacts, spans, and terminal output.
7. `src/discord/taskNotifications.ts` edits the original Discord status message with current progress and final PR/failure details.

Code-update tasks are being folded into the generic agent runtime. New control-plane work should prefer `src/db/agentRuntimeRepository.ts` and `/api/agent/sessions/:threadKey` over adding new codegen-only APIs.

### Run Console And Debugging

1. `src/observability/runs.ts` normalizes process runs, trace events, task events, tool audits, terminal logs, and artifacts.
2. `src/control/internalApi.ts` exposes `/api/runs`, `/api/runs/:id`, artifact fetch, and streams.
3. `src/control/console/` renders the React run console.
4. `scripts/inspectRun.ts`, `scripts/codegenStatus.ts`, and `inspectAgentLogs` are terminal/model-accessible debugging paths.
5. `inspectAgentLogs` accepts Discord message links, message IDs, run IDs, or trace IDs and includes the same normalized run diagnostics as the console when the referenced run is visible to the requester.
6. Worker processes run `src/observability/artifactRetention.ts` periodically to delete expired large run/codegen artifacts and their chunks.

Useful terminal entrypoints:

```sh
npm run runs:inspect -- --list --kind codegen --sort slowest --limit 10
npm run runs:inspect -- <run-id-or-discord-message-link> --terminal
npm run codegen:status
```

`runs:inspect` includes model token usage when providers return usage metadata and estimated spend from audited model/tool calls. Use it before digging through raw artifacts when debugging latency or cost.

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

For the broader implementation roadmap, see `docs/improvement-plan.md`.
