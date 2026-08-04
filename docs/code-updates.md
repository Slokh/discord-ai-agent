# Code updates

Members can ask the Discord agent to change its own repository, investigate CI, or repair a prior code-update task. The conversational agent creates durable work; a sandbox performs repository mutation and publication.

## Admission and authority

The model selects `runCodingAgent` only for an explicit current request to modify or debug repository, PR, CI, deployment, or prior task behavior. The feature is hidden when repository credentials or callback signing are incomplete.

Code-update admission is available to all guild members. Safety comes from isolated execution, scoped credentials, branch protection, verification, release scanning, and human review—not from trying to classify privileged language in chat.

The sandbox supervisor never receives the Discord token or database URL. It receives the OpenRouter and scoped GitHub credentials needed to run the task, but child npm lifecycle scripts and NanoCodex workspace commands use an allowlisted environment without provider, publication, or callback credentials. NanoCodex receives its model credential through the private startup protocol, and only the verified runner retains GitHub publication authority.

## Durable lifecycle

1. `src/tools/agentTaskTools.ts` records the task projection and exactly one task-linked runtime execution, then returns a status result to the parent chat turn.
2. `src/jobs/agentTaskEnqueue.ts` atomically hands the task to pg-boss. The parent tool call does not wait for the PR.
3. Discord task notification code creates or edits one progress message for queued, running, and terminal state.
4. `src/execution/backend.ts` creates an isolated Kubernetes Job.
5. `src/execution/runnerPipeline.ts` runs the complete repository pipeline.
6. Sandbox progress, commands, timings, cache state, and terminal callbacks become `agent.task.*` events in the canonical runtime ledger. Command output is retained as a redacted runtime artifact referenced by its event.
7. The task ends as succeeded, failed, cancelled, or no-change, with a PR link or concrete reason.

When the original requester marks a reply, the sandbox first performs evidence-only triage and code enforces a clean checkout. The marker is not proof: expected behavior, non-reproduction, an already-fixed source, or insufficient evidence finishes without a PR. Insufficient evidence produces a reply on the marked message that pings only the reporter and asks for concrete missing context. Only `confirmed_unfixed` with a machine-checkable regression contract starts a separate mutation-capable repair phase. When that confirmed repair reaches production, the marked bot reply becomes a persistent `Bug fix` update using the same format as ordinary deployment notes. Posting that contextual update triggers a retry of the original request into a fresh reply. A different member's marker remains available in that member's private inbox but cannot start or replay the original request. Contextual updates remain separate from the release-wide announcement, so every verified revision still receives its complete release-notes entry.

## Sandbox pipeline

The runner:

1. refreshes a cached bare mirror of the configured repository;
2. creates an isolated task worktree and safe branch;
3. restores a dependency snapshot keyed by Node version and package manifests, or runs `npm ci` to seed it;
4. builds an agent-oriented context pack from `AGENTS.md`, current docs, exact request anchors, nearby source, and focused checks;
5. runs the embedded NanoCodex runtime with workspace tools;
6. refreshes dependencies if the task changed manifests;
7. runs `npm run verify`, including the private-data release scan;
8. if verification fails, gives the bounded failure output to the coding agent for one focused repair and verifies again;
9. rejects empty, unsafe, or still-failing diffs;
10. pushes an allowed task branch and creates or updates the intended PR;
11. reports a terminal callback with exact output metadata.

The runner owns commit, push, and PR publication. The coding agent inside the sandbox edits and verifies but does not publish independently.

`src/execution/sandboxToolShims.ts` owns the intentionally small command surface injected into the coding environment. The pipeline installs those shims; feature behavior and callback authority remain in their canonical application owners.

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

## Kubernetes isolation

This backend creates one Job, Secret, and ConfigMap per task. The worker service account can manage those resources; the sandbox service account has no Kubernetes API permissions. Callback tokens bind task and sandbox-run identity, timestamp, and body. Terminal callbacks are accepted once.

NetworkPolicy should allow only DNS, the internal callback API, and the external hosts required for GitHub, OpenRouter, and package installation. A task uses only ephemeral local cache state; correctness never depends on cache persistence.

## Recovery

Reconcilers handle:

- a worker disappearing after a task starts;
- a Kubernetes Job failing, disappearing, or never sending a terminal callback;
- orphaned per-task Kubernetes resources;
- callback replay or a callback for an already terminal task;
- a sandbox ending without a diff;
- dependency changes discovered after the first install;
- CI or verification failures with retained command summaries.

Recovery produces an explicit terminal reason. It never silently publishes an unverified diff or marks a task successful only because a process exited.

Members can add `🔄` or `🔃` to a terminal task update to queue a fresh retry. The reaction is durably deduplicated per member and target message, and the new task links back to the failed task. Tasks linked to an improvement case retain that case ID; the case remains `in_progress` during the retry and still requires explicit deployed verification before resolution.

## Operations and verification

Inspect task state through the canonical runtime ledger from a trusted, configured application environment. The sandbox callback receiver accepts writes only; it deliberately has no task-reading HTTP API.

Changes to this lifecycle should test queue handoff, status rendering, context selection, branch policy, dependency refresh, callback authentication, terminal idempotency, cleanup, and publication metadata as relevant. Run `npm run verify`; run `npm run verify:db` for queue, task, or migration changes; run the appropriate smoke command only when credentials and external mutation are intentionally in scope.
