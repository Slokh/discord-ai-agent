# Architecture Map

This file is the short map for coding agents. Prefer this over rereading the whole repository before making a targeted change.

## Runtime Shape

Discord AI Agent is a TypeScript Node app with three production roles:

- `bot`: Discord gateway, mention detection, response rendering, per-channel conversation memory.
- `worker`: queue consumers for crawl, embeddings, Discord agent requests, codegen tasks, reconciliation, and cleanup.
- `api`: internal control plane for sandbox callbacks, run console APIs, metrics, and authenticated debugging UI.

Postgres is the durable source of truth for Discord messages, embeddings, skills, conversation memory, traces, process runs, task events, sandbox runs, and codegen sessions.

## Core Flows

### Discord Message To Answer

1. `src/discord/client.ts` receives a Discord message and checks whether the bot should respond.
2. The client persists message/edit/delete state, resolves reply context and image attachments, creates a run/trace, and builds a `ToolContext`.
3. `src/agent/router.ts` sends the user request, channel memory, reply context, image context, skills, and tool schemas to the model.
4. The model selects local tools from `src/tools/registry.ts` or OpenRouter-hosted tools.
5. Local tools execute in `src/tools/coreTools.ts`.
6. The router records trace events/tool audit rows and returns the final response/files.
7. `src/discord/responseSink.ts` renders the loading reaction, status message, final reply, attachments, or errors.

### Discord Memory And Retrieval

1. `src/discord/crawler.ts` and incremental message handlers store bot-visible messages and attachment metadata.
2. Embedding workers fill vector data for stored messages.
3. Retrieval tools in `src/tools/coreTools.ts` apply requester-visible channel filters before returning evidence.
4. The agent should prefer broad primitives: exact/semantic history search, recent context, stats, attachment search, image inspection, and summarization.

### Code Update Request To PR

1. The model calls `runCodingAgent` when the user explicitly asks the bot to update itself.
2. `src/tools/coreTools.ts` enqueues a durable agent task and edits the Discord status message with progress.
3. `src/jobs/queue.ts` claims the task and launches the configured execution backend.
4. `src/execution/backend.ts` starts either a Kubernetes Job or local process sandbox.
5. `src/execution/sandboxRunner.ts` prepares the repo, prompt, cache, harness config, tests, scan, push, and PR.
6. Sandbox callbacks hit `src/control/internalApi.ts`, which persists command events, artifacts, spans, and terminal output.
7. `src/discord/taskNotifications.ts` edits the original Discord status message with current progress and final PR/failure details.

### Run Console And Debugging

1. `src/observability/runs.ts` normalizes process runs, trace events, task events, tool audits, terminal logs, and artifacts.
2. `src/control/internalApi.ts` exposes `/api/runs`, `/api/runs/:id`, artifact fetch, and streams.
3. `src/control/console/` renders the React run console.
4. `scripts/inspectRun.ts`, `scripts/codegenStatus.ts`, and `inspectAgentLogs` are terminal/model-accessible debugging paths.

## Change Guidance

- Keep the Discord UX commandless: users should keep writing normal `@ai ...` prompts.
- Prefer improving model-facing tool descriptions, schemas, and outputs over hidden regex branches.
- Keep retrieval permission-aware.
- Keep private server data out of committed fixtures/docs/evals.
- For codegen reliability, improve context packaging, observable progress, and failure classification before changing harnesses.
- For answer quality, add or update eval prompts before tuning prompts/tools.
