# Agent Runtime And Codegen

Discord AI Agent is migrating toward a Centaur-style runtime where every Discord prompt is represented as a durable agent session, and code updates are one capability inside that session. The generic control-plane facade is `src/db/agentRuntimeRepository.ts` plus `/api/agent/sessions/:threadKey`.

The current code-update compatibility path still supports two execution backends:

- `kubernetes-job` (default): each task gets an isolated Kubernetes Job and branch
- `local-process`: a long-lived worker pod starts sandbox runner child processes locally, avoiding per-task Kubernetes Job creation and keeping repo, dependency, and harness caches warm in the worker

Both modes are cache-first:

- a shared PVC keeps the bare Git mirror, npm download cache, and dependency snapshots warm
- per-task worktrees live on sandbox-local temporary storage and are cleaned after the task
- phase progress, command output tails, cache hit/miss events, and timings are persisted as task events

This keeps the user-facing flow synchronous while removing the most expensive repeated setup from the request path.

## Durable Agent Session API

The internal API now exposes generic agent control-plane objects. Authenticated clients can:

- `POST /api/agent/sessions/:threadKey` to create or reuse a durable agent session for a Discord channel/thread context.
- `GET /api/agent/sessions/:threadKey` to replay the session, messages, executions, and events.
- `POST /api/agent/sessions/:threadKey/messages` to persist one user/system/assistant/tool turn as structured parts.
- `GET /api/agent/sessions/:threadKey/messages` to replay stored turns.
- `POST /api/agent/sessions/:threadKey/execute` to create a durable queued execution row.
- `GET /api/agent/sessions/:threadKey/events` to replay normalized execution events.
- `GET /api/agent/sessions/:threadKey/artifacts/:artifactId` to fetch stored execution artifacts such as the `turn_envelope`.
- `GET /api/agent/sessions/:threadKey/stream` to follow the replayable event trail over SSE.

The first migration slices record Discord prompts and their compatibility execution in this generic session ledger. Each Discord turn stores a `turn_envelope` artifact with the serializable request context: prompt text, Discord IDs, visible channels, reply context, attachments, delivery message IDs, and recent channel memory. Queued prompt execution carries that artifact id and replays the stored envelope when available, falling back to Discord-message reconstruction only for old jobs or missing artifacts.

`POST /api/agent/sessions/:threadKey/execute` is also the migration seam for making the session API the real control plane. It accepts Centaur-style opaque `input_lines` / `inputLines` arrays, stores them as a durable `input_lines` artifact, records `agent.execution.input_lines_stored`, and returns the artifact id so future warm harness runners can replay exactly what the client intended to write to runtime stdin. When the API process has a job runtime and the request includes `enqueue: true` plus enough Discord delivery context (`messageId`, `guildId`, `channelId`, `userId`, and text, either directly or from the session), the endpoint creates the durable execution row, enqueues the `agent.runtime.execution` job, records `agent.execution.job_enqueued`, and returns the pg-boss `jobId`. Clients that only need ledger state can omit `enqueue`. Discord gateway ingress uses the same control-plane helper for this queue handoff, falling back to direct enqueue only if session recording failed.

`AGENT_RUNTIME_EXECUTION_BACKEND` selects the prompt execution backend. It defaults to `in-process`, which calls the existing model/tool router through `src/agent/inProcessRuntimeExecutor.ts`. The selection now flows through `src/agent/runtimeRunner.ts` and `src/agent/runtimeExecutor.ts` so the worker can prepare the Discord turn once, store the replay envelope, then hand response generation to the selected executor. `warm-sandbox` sends that envelope to `AGENT_RUNTIME_WARM_SANDBOX_URL` when configured; otherwise it falls back to the out-of-process `sandboxPromptRunner` child for local compatibility.

Warm prompt executions write a `Warm sandbox prompt runner` span and `raw_json` artifacts for the serialized prompt request and response. Span/artifact metadata includes the selected transport (`http` or `child_process`) plus HTTP status or process byte counts, so latency and protocol bugs are visible in the run console.

Run a local warm prompt server with:

```sh
npm run agent:warm-server
```

In Kubernetes, set:

```sh
--set agentRuntime.executionBackend=warm-sandbox
--set agentRuntime.warmSandbox.enabled=true
```

The Helm chart deploys a ClusterIP `agent-runtime` service and points the worker at it through `AGENT_RUNTIME_WARM_SANDBOX_URL`. The warm prompt server starts an enqueue-only job runtime so model-selected code-update tools can still enqueue normal `agent.task` work while prompt execution runs behind the remote runtime boundary. When a warm-runtime tool enqueues a code-update task before a Discord status message exists, the Discord worker attaches tasks from the same prompt trace to the final reply message so the normal task notifier can edit that reply with progress and the PR link.

## Legacy Codegen Session API

The internal API now exposes the codegen control-plane objects directly. This is the migration point from the original `agent.task` callback flow toward a Centaur-style runtime where Discord is only ingress/delivery and the API owns durable execution state.

Authenticated clients can:

- `POST /api/codegen/sessions/:threadKey` to create or reuse a durable codegen session for a Discord channel/thread/task context.
- `GET /api/codegen/sessions/:threadKey` to replay the session, messages, executions, and events.
- `POST /api/codegen/sessions/:threadKey/messages` to persist one user/system/assistant/tool turn as structured parts.
- `GET /api/codegen/sessions/:threadKey/messages` to replay stored turns.
- `POST /api/codegen/sessions/:threadKey/execute` to create a durable queued execution row.
- `GET /api/codegen/sessions/:threadKey/events` to replay normalized execution events.
- `GET /api/codegen/sessions/:threadKey/stream` to follow the replayable event trail over SSE.

The old task callback endpoints remain for the current sandbox runner. New runtime work should attach to the generic agent session API first, then route executions to warm sandboxes, harness servers, and Discord delivery from that durable event stream.

Today, `enqueueAgentTask` creates or reuses the durable codegen session, appends the code-update request as a `user` message, and creates a queued harness execution before handing work to the existing `agent.task` queue. This keeps the current Discord behavior intact while making the codegen session/event trail the durable source of truth for future scheduler and UI work.

The same enqueue path now also calls `src/jobs/agentTaskRuntimeMirror.ts` to mirror code-update tasks into the generic agent runtime session for the originating Discord thread. The mirror writes a `runCodingAgent` tool message, a task-linked execution with the same `taskId`, and `agent.task.*` events for queue, start, progress, sandbox attachment, and immediate start failures. This is the bridge from the legacy `agent.task` queue toward Centaur-style sessions where code updates are just long-running work inside the conversation.

## Harness Profile

Code-update tasks use their own coding harness model via `OPENROUTER_CODEGEN_MODEL`, falling back to `OPENROUTER_CHAT_MODEL` when unset. This lets normal Discord chat stay on a cheap conversational model while code updates can move independently to a model better suited to repository edits.

The sandbox writes an ephemeral harness profile with the same posture used by Centaur-style coding harnesses:

- `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` because Kubernetes is the external sandbox boundary
- low reasoning/verbosity, pragmatic response style, and fast service tier where the selected harness supports those options
- structured streaming enabled where available so turn notifications, item updates, token usage, and errors are captured as events
- OpenCode is the default harness; Codex app-server/exec remains available when `CODEGEN_HARNESS=codex`

The next runtime migration should preserve this harness posture while moving from per-task harness processes to a long-lived harness server/session inside each warm worker.

## Prompt And Context Policy

Codegen prompts should stay generic and architecture-driven:

- Start from `AGENTS.md`, `docs/architecture.md`, and the nearest `src/**/README.md`.
- Use preflight context as a map, not a research backlog.
- Prefer domain classification over long generated file lists.
- Treat model-facing tool names as strong anchors only when the request is about tool schemas, routing, arguments, descriptions, or contracts.
- For product behavior requests, route to the owning lifecycle first: Discord response, knowledge/indexing/retrieval, agent task status, run console, or sandbox execution.
- Track first-edit latency and repeated reads as prompt/context quality signals. If the agent spends many rounds before editing, improve ownership maps or context classification before adding task-specific prompt instructions.

## Current Isolation Model

Every code-update request still has its own task branch and sandbox process. The sandbox receives only the task callback token, GitHub task token, OpenRouter key, repo coordinates, and task prompt. The worker reconciler marks tasks failed if a sandbox exits without a terminal callback.

In `kubernetes-job` mode, the reconciler also cleans up the Kubernetes Job, Secret, and ConfigMap. In `local-process` mode, the long-lived worker tracks the spawned child process and no Kubernetes per-task resources are created.

In `local-process` mode, each task worker registers one row in `codegen_sandbox_leases` for its local warm execution slot. The worker heartbeats that row, acquires its own lease before spawning a codegen child process, waits when the slot is already leased, and task terminal updates release the row back to `idle`. This makes the lease table part of scheduling rather than just observability.

## Cache Model

The retained cache contains:

- `repos/`: bare Git mirrors refreshed from origin before checkout
- `npm/`: npm download cache
- `node_modules/`: dependency snapshots keyed by Node version, `package.json`, and `package-lock.json`
- `locks/`: filesystem lock directories for cache mutation

If the coding harness changes `package.json` or `package-lock.json`, the sandbox refreshes dependencies before verification so tests run with the generated dependency graph.

## Backend Selection

Set `CODEGEN_EXECUTION_BACKEND` to choose the backend:

- `kubernetes-job`: safest isolation boundary and current default.
- `local-process`: lower latency mode for a dedicated codegen worker pod. In Helm, enable `codegenWorker.enabled=true`; that deployment consumes only `agent.task`, sets `CODEGEN_EXECUTION_BACKEND=local-process`, and mounts the sandbox cache PVC when `sandbox.cache.enabled=true`.

Use `local-process` only for a pod you already treat as the code execution boundary. When `codegenWorker.enabled=true`, the regular worker stops consuming code-update task jobs so crawl, embedding, and agent runtime execution work stay separate from warm codegen execution.

Warm workers coordinate through `codegen_sandbox_leases`. The default lease behavior is:

- heartbeat every 15 seconds
- consider a lease stale after 120 seconds without a heartbeat
- wait up to 30 minutes for the warm worker slot before failing the task
- poll for the lease every 5 seconds while waiting

Override these with `CODEGEN_LEASE_HEARTBEAT_SECONDS`, `CODEGEN_LEASE_STALE_SECONDS`, `CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS`, and `CODEGEN_LEASE_ACQUIRE_POLL_SECONDS`. In Helm, use `codegenWorker.lease.*`. Wait/acquire events include the active timeout and poll interval so the run console can explain whether a task is actually executing or queued behind the warm slot.

## Warm Runtime Direction

The next Centaur-like steps are:

1. Move from the dedicated warm codegen worker pod to true warm sandbox pods that keep a harness server alive behind the same lease table.
2. Keep the selected harness server/session warm per worker and reuse threads/sessions across recovery turns instead of spawning a fresh process per task.
3. Add queue routing/fallback so a task uses a warm worker when one is available and falls back to `kubernetes-job` when the warm pool is saturated.
4. Move credential access toward a control-plane or proxy boundary so sandboxes can use task-scoped credentials without receiving broad long-lived secrets directly.

The existing `ExecutionBackend` interface, task event stream, cache metrics, and operator scripts are intended to survive that migration.

## Task Terminal UI

The internal API serves a lightweight task viewer at `/tasks`. It shows recent code-update tasks, task status, sandbox metadata, completed command tails, and live stdout/stderr snippets from long-running harness, verify, scan, and dependency-install steps.

By default, the API service is cluster-internal. Open it locally with:

```sh
kubectl -n discord-ai-agent port-forward svc/discord-ai-agent-api 8080:8080
```

Then visit `http://localhost:8080/runs`.

For local React console iteration against real run data, use:

```sh
npm run console:dev:live
```

This command prefers an explicit `CONSOLE_API_TARGET`, then `CONTROL_UI_PUBLIC_URL`, then the deployed Kubernetes app's `CONTROL_UI_PUBLIC_URL` and auth secret when `kubectl` can read them, and finally `http://localhost:8080`. The intended default is production run data when available, with a local API fallback.

If you expose the API service on a public hostname, set `CONTROL_UI_AUTH_PASSWORD` in the runtime Secret first. Browser access uses Basic auth with username `admin`; scripts may also use `Authorization: Bearer $CONTROL_UI_AUTH_PASSWORD`. Set `CONTROL_UI_PUBLIC_URL` to the externally reachable console origin, such as `https://tasks.example.com`, so Discord code-update progress messages include a direct `/runs/<taskId>` console link. Do not include `/runs` in the value; the bot appends the run path itself.

To share a pre-authenticated link, append `?auth=$CONTROL_UI_AUTH_PASSWORD` to any run-console URL. The server validates the token, stores an HttpOnly cookie for 30 days, then redirects to the same URL without the auth query parameter.

For a terminal-first health check, run:

```sh
npm run codegen:status
```

The status command summarizes active code-update tasks, pg-boss `agent.task` state counts, sandbox run cleanup backlog, warm-worker lease heartbeats, recent terminal failures, and stale-work diagnostics. Use `--stale-minutes` to tune the threshold while debugging a suspected hang, and `--json` when another tool needs the raw snapshot.

When you do not have direct database access, point the same command at the authenticated control API:

```sh
npm run codegen:status -- --source api --api-url https://tasks.example.com
```

## Local Codegen Smoke Tests

Use the smoke runner when you need to test a real coding harness loop without Discord or Kubernetes:

```sh
npm run smoke:codegen -- --harness opencode --model z-ai/glm-5.2 --close-pr
```

The script starts a temporary local task callback server, runs `src/execution/sandboxRunner.ts` directly, records callbacks and artifacts under `.discord-ai-agent/codegen-smoke/<task-id>/`, and writes a `summary.md` with duration, completion status, failure diagnosis, PR URL, and callback timeline.

For long or exact Discord prompts, put the prompt in a local file and pass:

```sh
npm run smoke:codegen -- --request-file .discord-ai-agent/codegen-smoke/request.txt --close-pr
```

To run a repeatable local codegen regression suite, put cases in a gitignored JSON file:

```json
{
  "version": 1,
  "name": "private-codegen-regressions",
  "cases": [
    {
      "id": "tool-schema-context",
      "title": "Improve tool schema context",
      "request": "Make the coding agent handle tool schema changes with a focused test first."
    }
  ]
}
```

Then run:

```sh
npm run smoke:codegen -- --suite .discord-ai-agent/codegen-smoke/suite.json --harness opencode --model z-ai/glm-5.2 --close-pr
```

Suite reports are written under `.discord-ai-agent/codegen-smoke/suites/` with aggregate `summary.md` and `results.json` files. Cases can override `harness`, `model`, `timeoutMs`, `closePr`, `title`, `request`, or `requestFile`; use `skip` and `skipReason` to keep costly cases documented but disabled.

Use `--close-pr` for iteration runs that should automatically close the generated smoke PR and delete its branch. Omit it only when you intentionally want to inspect the opened PR on GitHub.
