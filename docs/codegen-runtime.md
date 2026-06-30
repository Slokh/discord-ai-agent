# Codegen Runtime

Discord AI Agent uses Kubernetes sandboxes for code-update tasks. The default runtime is cache-first:

- each task gets an isolated Kubernetes Job and branch
- a shared PVC keeps the bare Git mirror, npm download cache, and dependency snapshots warm
- per-task worktrees live on sandbox-local temporary storage and are cleaned after the task
- phase progress, command output tails, cache hit/miss events, and timings are persisted as task events

This keeps the user-facing flow synchronous while removing the most expensive repeated setup from the request path.

An optional warm-pool runtime can keep reusable sandbox Pods online. When `SANDBOX_WARM_POOL_ENABLED=true`, the worker maintains up to `SANDBOX_WARM_POOL_SIZE` warm Pods per configured repository/base branch, claims a ready Pod for a task, launches the task runner through Kubernetes exec, and releases the Pod after the terminal callback. Any miss, stale Pod, failed exec, or missing pool dependency falls back to the cold Job path.

## Current Isolation Model

Every code-update request still has its own task branch and sandbox process. The sandbox receives only the task callback token, GitHub task token, OpenRouter key, repo coordinates, and task prompt. The worker reconciler marks tasks failed if a sandbox exits without a terminal callback, then cleans up cold Kubernetes Job resources or releases the warm sandbox lease.

## Cache Model

The retained cache contains:

- `repos/`: bare Git mirrors refreshed from origin before checkout
- `npm/`: npm download cache
- `node_modules/`: dependency snapshots keyed by Node version, `package.json`, and `package-lock.json`
- `locks/`: filesystem lock directories for cache mutation

If Codex changes `package.json` or `package-lock.json`, the sandbox refreshes dependencies before verification so tests run with the generated dependency graph.

## Warm Runtime

The warm-pool runtime follows the Centaur-like shape without removing the simpler cold backend:

1. `warm_sandboxes` stores sandbox ID, repo key, status, lease owner, heartbeat, last-used time, and metadata.
2. Long-lived sandbox Pods keep the repo mirror and dependency store mounted.
3. The worker claims a ready sandbox with a database lease, creates a fresh worktree/branch inside the task runner, executes Codex, then releases the sandbox.
4. The cold Kubernetes Job backend remains the fallback when no warm sandbox is available.
5. The next hardening step is moving credential access toward a control-plane or proxy boundary so sandboxes can use task-scoped credentials without receiving broad long-lived secrets directly.

The existing `ExecutionBackend` interface, task event stream, cache metrics, and operator scripts are intended to survive that migration.
