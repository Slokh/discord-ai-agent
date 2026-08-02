# Code updates

Members can ask the Discord agent to change its own repository, investigate CI, or repair a prior code-update task. The conversational agent creates durable work; a sandbox performs repository mutation and publication.

## Admission and authority

The model selects `runCodingAgent` only for an explicit current request to modify or debug repository, PR, CI, deployment, or prior task behavior. The feature is hidden when repository credentials or callback signing are incomplete.

Code-update admission is available to all guild members. Safety comes from isolated execution, scoped credentials, branch protection, verification, release scanning, and human review—not from trying to classify privileged language in chat.

The sandbox never receives the Discord token or database URL. It receives only the task context, OpenRouter credential, scoped GitHub credential, and callback token required for its job.

## Durable lifecycle

1. `src/tools/agentTaskTools.ts` records the task projection and a task-linked runtime execution, then returns a status result to the parent chat turn.
2. `src/jobs/agentTaskEnqueue.ts` atomically hands the task to pg-boss. The parent tool call does not wait for the PR.
3. Discord task notification code creates or edits one progress message for queued, running, and terminal state.
4. `src/execution/backend.ts` selects `local-process` or `kubernetes-job`.
5. `src/execution/runnerPipeline.ts` runs the complete repository pipeline.
6. Sandbox progress, commands, timings, cache state, and terminal callbacks become `agent.task.*` events in the canonical runtime ledger.
7. The task ends as succeeded, failed, cancelled, or no-change, with a PR link or concrete reason.

The original conversational reply should be retried after a successfully deployed automated bug repair so the user receives the requested result, not only repair metadata.

## Sandbox pipeline

The runner:

1. refreshes a cached bare mirror of the configured repository;
2. creates an isolated task worktree and safe branch;
3. restores a dependency snapshot keyed by Node version and package manifests, or runs `npm ci` to seed it;
4. builds an agent-oriented context pack from `AGENTS.md`, current docs, exact request anchors, nearby source, and focused checks;
5. runs the embedded NanoCodex runtime with workspace tools;
6. refreshes dependencies if the task changed manifests;
7. verifies the change and runs the private-data release scan;
8. rejects empty or unsafe diffs;
9. pushes an allowed task branch and creates or updates the intended PR;
10. reports a terminal callback with exact output metadata.

The runner owns commit, push, and PR publication. The coding agent inside the sandbox edits and verifies but does not publish independently.

## Context and documentation

`src/execution/contextPack.ts` gives the coding agent a compact map of current owners rather than copying historical plans or stale folder READMEs. Exact identifiers from the request are searched first. The first useful edit and closest test are preferred over broad repository archaeology.

The task request remains authoritative. Generated diagnoses, previous attempts, PR metadata, and retained logs provide context but must not replace the requested outcome.

## Git policy

- New automated branches use the `agent/` prefix.
- Pushes to the configured base or protected branch names are refused.
- Existing open PR work may target its existing head branch only after the PR state is verified.
- A merged PR is immutable; follow-up work starts from current base and opens a new PR.
- PR titles and bodies describe the actual diff and user impact, not task IDs or generic validation metadata.
- PR bodies include verification and requester attribution without private Discord content.
- A PR is opened only for a real repository diff.

GitHub App installation credentials are preferred in production. A local PAT should be fine-grained and limited to the configured repository.

## Backends

### Local process

This is the default. A worker launches the sandbox runner as a child process and reuses the mirror, npm cache, dependency snapshots, and harness artifacts under `SANDBOX_CACHE_DIR`. A durable sandbox lease prevents multiple workers from claiming the same warm slot and records queue/acquire/heartbeat/release state.

### Kubernetes Job

This backend creates one Job, Secret, and ConfigMap per task. The worker service account can manage those resources; the sandbox service account has no Kubernetes API permissions. Callback tokens bind task and sandbox-run identity, timestamp, and body. Terminal callbacks are accepted once.

NetworkPolicy should allow only DNS, the internal callback API, and the external hosts required for GitHub, OpenRouter, and package installation. A shared cache PVC is optional and must match the concurrency/storage model.

## Recovery

Reconcilers handle:

- a worker disappearing after a task starts;
- stale or lost local-process leases;
- a Kubernetes Job failing, disappearing, or never sending a terminal callback;
- orphaned per-task Kubernetes resources;
- callback replay or a callback for an already terminal task;
- a sandbox ending without a diff;
- dependency changes discovered after the first install;
- CI or verification failures with retained command summaries.

Recovery produces an explicit terminal reason. It never silently publishes an unverified diff or marks a task successful only because a process exited.

## Operations and verification

Inspect tasks with:

```bash
npm run tasks:status
npm run runs:inspect -- --list --limit 20
npm run sandbox-cache:status
```

Use `sandbox-cache:prune` for bounded cleanup. `sandbox-cache:clear` is destructive and requires deliberate operator use.

Changes to this lifecycle should test queue handoff, status rendering, context selection, branch policy, dependency refresh, callback authentication, terminal idempotency, cleanup, and publication metadata as relevant. Run `npm run verify`; run `npm run verify:db` for queue, lease, task, or migration changes; run the appropriate smoke command only when credentials and external mutation are intentionally in scope.
