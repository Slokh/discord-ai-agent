# Codegen Runtime

Discord AI Agent uses Kubernetes sandbox Jobs for code-update tasks. The current runtime is cache-first:

- each task gets an isolated Kubernetes Job and branch
- a shared PVC keeps the bare Git mirror, npm download cache, and dependency snapshots warm
- per-task worktrees live on sandbox-local temporary storage and are cleaned after the task
- phase progress, command output tails, cache hit/miss events, and timings are persisted as task events

This keeps the user-facing flow synchronous while removing the most expensive repeated setup from the request path.

## Harness Profile

Code-update tasks use their own coding harness model via `OPENROUTER_CODEGEN_MODEL`, falling back to `OPENROUTER_CHAT_MODEL` when unset. This lets normal Discord chat stay on a cheap conversational model while code updates can move independently to a model better suited to repository edits.

The sandbox writes an ephemeral Codex profile with the same posture used by Centaur-style coding harnesses:

- `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` because Kubernetes is the external sandbox boundary
- `model_reasoning_effort = "low"`, `model_verbosity = "low"`, `personality = "pragmatic"`, and `service_tier = "fast"`
- Codex `fast_mode` and `runtime_metrics` enabled
- `codex exec --json` so command output is structured event JSON instead of plain terminal prose

The next runtime migration should preserve this harness profile even if the transport moves from one-shot `codex exec` to a long-lived Codex app-server session.

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
2. Run long-lived codegen worker Pods that keep the repo mirror, dependency store, Codex home, and optional app-server process warm.
3. Lease a warm sandbox for each task, create a fresh worktree/branch under that sandbox, execute the harness session, then release or recycle the sandbox.
4. Keep fallback support for the current Kubernetes Job backend when no warm sandbox is available.
5. Move credential access toward a control-plane or proxy boundary so sandboxes can use task-scoped credentials without receiving broad long-lived secrets directly.
6. Replace the `codex exec` transport with a Codex app-server adapter once the session/event protocol is owned by this codebase.

The existing `ExecutionBackend` interface, task event stream, cache metrics, and operator scripts are intended to survive that migration.

## Task Terminal UI

The internal API serves a lightweight task viewer at `/tasks`. It shows recent code-update tasks, task status, sandbox metadata, completed command tails, and live stdout/stderr snippets from long-running Codex, verify, scan, and dependency-install steps.

By default, the API service is cluster-internal. Open it locally with:

```sh
kubectl -n discord-ai-agent port-forward svc/discord-ai-agent-api 8080:8080
```

Then visit `http://localhost:8080/runs`.

If you expose the API service on a public hostname, set `CONTROL_UI_AUTH_PASSWORD` in the runtime Secret first. Browser access uses Basic auth with username `admin`; scripts may also use `Authorization: Bearer $CONTROL_UI_AUTH_PASSWORD`. Set `CONTROL_UI_PUBLIC_URL` to the externally reachable console origin, such as `https://tasks.example.com`, so Discord code-update progress messages include a direct `/runs/<taskId>` console link. Do not include `/runs` in the value; the bot appends the run path itself.

To share a pre-authenticated link, append `?auth=$CONTROL_UI_AUTH_PASSWORD` to any run-console URL. The server validates the token, stores an HttpOnly cookie for 30 days, then redirects to the same URL without the auth query parameter.
