# Codegen Runtime

Discord AI Agent uses Kubernetes sandbox Jobs for code-update tasks. The current runtime is cache-first:

- each task gets an isolated Kubernetes Job and branch
- a shared PVC keeps the bare Git mirror, npm download cache, and dependency snapshots warm
- per-task worktrees live on sandbox-local temporary storage and are cleaned after the task
- phase progress, command output tails, cache hit/miss events, and timings are persisted as task events

This keeps the user-facing flow synchronous while removing the most expensive repeated setup from the request path.

## Current Isolation Model

Every code-update request still has its own task branch and sandbox process. The sandbox receives only the task callback token, GitHub task token, OpenRouter key, repo coordinates, and task prompt. The worker reconciler marks tasks failed if a sandbox exits without a terminal callback, then cleans up the Kubernetes Job, Secret, and ConfigMap.

## Cache Model

The retained cache contains:

- `repos/`: bare Git mirrors refreshed from origin before checkout
- `npm/`: npm download cache
- `node_modules/`: dependency snapshots keyed by Node version, `package.json`, and `package-lock.json`
- `locks/`: filesystem lock directories for cache mutation

If Codex changes `package.json` or `package-lock.json`, the sandbox refreshes dependencies before verification so tests run with the generated dependency graph.

## Warm Runtime Direction

The next Centaur-like step is a warm codegen runtime instead of one Job per task:

1. Add a `codegen_sandboxes` or `warm_sandboxes` table with sandbox ID, repo, status, lease owner, heartbeat, last used time, and cache metadata.
2. Run long-lived codegen worker Pods that keep the repo mirror and dependency store mounted.
3. Lease a warm sandbox for each task, create a fresh worktree/branch under that sandbox, execute Codex, then release or recycle the sandbox.
4. Keep fallback support for the current Kubernetes Job backend when no warm sandbox is available.
5. Move credential access toward a control-plane or proxy boundary so sandboxes can use task-scoped credentials without receiving broad long-lived secrets directly.

The existing `ExecutionBackend` interface, task event stream, cache metrics, and operator scripts are intended to survive that migration.
