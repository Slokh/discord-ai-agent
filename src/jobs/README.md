# Jobs

Owns pg-boss setup, queue handoff helpers, and worker dispatch.

## Files

- `queue.ts`: wires queues, worker consumers, and queue runtime methods. Keep this as orchestration glue.
- `agentTaskEnqueue.ts`: owns the code-update task enqueue transaction: durable task row, codegen mirror, generic runtime fallback mirror, pg-boss send, and queue metadata adoption.
- `agentTaskCodegenMirror.ts`: mirrors code-update task requests into the legacy codegen session/execution ledger.
- `agentTaskRuntimeMirror.ts`: mirrors code-update task requests into the generic agent-runtime ledger when the caller did not already create a runtime execution.
- `codegenLeaseScheduler.ts`: coordinates warm codegen worker leases.

## Change Guidance

- Put lifecycle facts in the smallest owner that represents that lifecycle. Queue setup belongs in `queue.ts`; task enqueue bookkeeping belongs in `agentTaskEnqueue.ts`; execution start/progress belongs in the execution backend and repository lifecycle methods.
- Do not reset task-linked executions to `queued` after pg-boss accepts a job. Fast workers may already have marked the same execution `running`.
- Keep job payloads small and replayable. Durable context should live in Postgres artifacts or repository rows, with the job carrying ids needed to resume the work.
