# Agent Runtime

The agent runtime is the durable ledger for Discord AI Agent prompt execution. Both ordinary Discord chat turns and sandboxed code-update tasks are represented as sessions, executions, messages, events, artifacts, and sandbox leases owned by `src/db/agentRuntimeRepository.ts`.

## Durable ledger

The runtime tables are:

- `agent_runtime_sessions`: one replayable session per Discord thread/channel context or task-linked runtime context. Sessions carry `thread_key`, requester metadata, status, selected harness/model/provider, and `harness_thread_id` when a harness has an external thread/session id.
- `agent_runtime_executions`: one queued/running/terminal execution attempt inside a session. Code-update executions link to `agent_tasks.task_id`; chat executions do not create `process_runs` rows.
- `agent_runtime_messages`: structured system/user/assistant/tool transcript parts for replay.
- `agent_runtime_events`: normalized execution timeline events. Code-update progress/debugging uses `agent.task.*` events here as the canonical source.
- `agent_runtime_artifacts` and `agent_runtime_artifact_chunks`: replay and diagnostic payloads such as Discord turn envelopes, `input_lines`, transcripts, and large artifacts.
- `agent_runtime_sandbox_leases`: warm local-process sandbox slot leases for code-update workers.

`AgentRuntimeRepository` is the single repository class for this ledger. Fresh installs apply the squashed `migrations/001_initial.sql` baseline and every later numbered forward migration; existing pre-squash databases run `scripts/legacy-schema-transition.sql` once before applying the current migration chain, preserving legacy runtime data in place.

## Control API

`src/control/internalApi.ts` exposes the authenticated session API:

- `POST /api/agent/sessions/:threadKey`: create or update a durable session.
- `GET /api/agent/sessions/:threadKey`: return the session with recent messages, executions, and events.
- `POST /api/agent/sessions/:threadKey/messages`: append one structured message.
- `GET /api/agent/sessions/:threadKey/messages`: list session messages.
- `POST /api/agent/sessions/:threadKey/execute`: create an execution, store optional `input_lines`, and optionally enqueue the execution when Discord delivery context is supplied.
- `GET /api/agent/sessions/:threadKey/events`: list session events, optionally filtered by `executionId` and `afterEventId`.
- `GET /api/agent/sessions/:threadKey/artifacts/:artifactId`: fetch a stored runtime artifact.
- `GET /api/agent/sessions/:threadKey/stream`: stream runtime events over SSE.

The task status health endpoint is `GET /api/tasks/status`; the matching npm script is `npm run tasks:status`.

## Discord chat turns

Discord mentions enter through `src/discord/client.ts`, persist a user transcript message, create an agent-runtime execution, and store replayable artifacts through `src/agent/runtimeEnvelope.ts`. Queue handoff uses `src/agent/runtimeControlPlane.ts` to enqueue an `agent.runtime.execution` pg-boss job with ids for the session, execution, turn envelope, and input-lines artifact.

Chat prompt execution runs in-process through `src/agent/runtimeRunner.ts`, `src/agent/runtimeExecutor.ts`, and `src/agent/inProcessRuntimeExecutor.ts`. Sandboxes are not used for chat turns. The executor loads the stored envelope/input lines, builds the `ToolContext`, runs the model loop, mirrors assistant/tool transcript state into `agent_runtime_messages`, records `agent.execution.*` events, and lets Discord delivery code render acknowledgements, status, final replies, files, and cleanup.

## Code-update tasks

When the model calls `runCodingAgent`, `src/tools/agentTaskTools.ts` creates a `runCodingAgent` tool message and a task-linked runtime execution in the current session when one is available, then enqueues the `agent.task` pg-boss job. `src/jobs/agentTaskEnqueue.ts` owns the enqueue transaction and writes the runtime records when the caller has not already created them.

The `agent_tasks` row remains the task projection used by Discord notifications, queue workers, and compatibility task APIs, but the runtime session/execution/event rows are the canonical execution ledger. Sandbox progress, command summaries, lifecycle transitions, and terminal state are recorded as `agent.task.*` events in `agent_runtime_events`.

## Sandbox lease model

Code-update tasks run through `src/execution/backend.ts` using either:

- `kubernetes-job`: an isolated Kubernetes Job per task.
- `local-process`: a long-lived worker process that launches local sandbox child processes and reuses warm repo/dependency/harness caches.

In `local-process` mode, `src/jobs/sandboxLeaseScheduler.ts` registers and heartbeats one `agent_runtime_sandbox_leases` row for the worker's warm execution slot. The worker acquires that lease before spawning a sandbox process, waits while another execution owns the slot, and releases the lease when the task reaches a terminal state. Lease wait/acquire events include timeout and poll metadata so the run console and `tasks:status` can distinguish active execution from queueing behind a warm slot.

## Observability

The run console and `runs:inspect` normalize runtime sessions, executions, messages, events, artifacts, process runs, traces, terminal command logs, and task projections. Chat-run views come from the agent-runtime ledger; code-update task timelines join the task projection with the task-linked runtime execution and `agent.task.*` events. Data retention deletes old runtime events under the `agentRuntimeEvents` result key.
