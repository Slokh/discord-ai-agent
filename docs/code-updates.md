# Sandbox tasks and code updates

Members can ask the Discord agent to run or operate something (a program, game, installer, archive, or site), to change its own repository, to investigate CI, or to repair a prior task. The conversational agent creates durable work; one isolated sandbox implementation performs it and reports back.

## Profiles

Every task runs through the same queue, Kubernetes Job, runner, NanoCodex harness, signed callbacks, and Discord delivery. The task type selects only a profile in `src/execution/sandboxProfiles.ts`:

| Profile | Task types | Workspace | Outcome | Helpers | Upstream credentials |
| --- | --- | --- | --- | --- | --- |
| `repository` | `code_update`, `improvement_repair`, `improvement_report`, `diagnosis` | cached checkout | PR, or a reported result for `diagnosis`/`improvement_report` | `agent-task-context`, `agent-cache-info` | GitHub, OpenRouter |
| `computer` | `computer_task` | empty scratch directory | reported result with up to four files | `agent-fetch`, `agent-desktop`, `agent-deliver` | OpenRouter |

Code must branch on a profile property, never on a task-type literal. Adding a workload means adding a profile row and its helpers, not a parallel lifecycle.

## Admission and authority

The model selects `runSandboxAgent` with `mode=computer` when a member wants something run or used, `mode=code_change` for an explicit repository change, and `mode=diagnosis` for explicitly read-only repository, PR, CI, or deployment investigation. Each mode is enabled independently by `productConfig.sandbox.modes`. The tool is hidden while every mode is off, and a disabled mode or missing credential returns a not-configured result. Repository modes additionally require GitHub credentials; the computer mode does not. Enable a mode only after the isolated sandbox pool described below is deployed.

Sandbox admission is available to all guild members. Safety comes from isolated execution, scoped credentials, branch protection, required verification, and release scanning—not from trying to classify privileged language in chat.

The sandbox supervisor never receives the Discord token or database URL. It receives the OpenRouter and scoped GitHub credentials needed to run the task, but child npm lifecycle scripts and NanoCodex workspace commands use an allowlisted environment without provider, publication, or callback credentials. NanoCodex receives its model credential through the private startup protocol, and only the verified runner retains GitHub publication authority.

## Durable lifecycle

1. `src/tools/agentTaskTools.ts` records the task projection and exactly one task-linked runtime execution, then returns a status result to the parent chat turn.
2. `src/jobs/agentTaskEnqueue.ts` atomically hands the task to pg-boss. The parent tool call does not wait for the PR.
3. When the task becomes terminal, the bot's `src/discord/taskResultDelivery.ts` stores one versioned Discord delivery intent (the formatted result plus any files the sandbox agent delivered) and a `discord_delivery_obligations` row of kind `agent_task_result`. The shared delivery sweep replies to the requester's original message and appends the result to their conversation memory. Delivery is durable, retried, and ledger-visible like chat replies; improvement tasks report through the reporter-conversation lifecycle instead.
4. The task worker admits one repository sandbox at a time on the shared production node. Later work remains durably queued, and the worker holds the active queue job until its task reaches a durable terminal state.
5. `src/execution/backend.ts` creates an isolated Kubernetes Job.
6. `src/execution/runnerPipeline.ts` runs the complete repository pipeline.
7. Sandbox progress, commands, timings, cache state, and terminal callbacks become `agent.task.*` events in the canonical runtime ledger. Command output is retained as a redacted runtime artifact referenced by its event.
8. The task ends as succeeded, failed, cancelled, or no-change, with a PR link or concrete reason.

Report signals enter the unified improvement worker rather than a reaction-specific execution path. Each signal snapshot gets one deterministic assessment task. The sandbox first performs evidence-only triage and code enforces a clean checkout. Expected behavior, non-reproduction, or an already-fixed source dismisses the report without GitHub work. A specific ambiguity moves the case to `needs_evidence` with the exact clarification required. Only `confirmed_unfixed` with a registered machine-executable contract starts the mutation-capable repair phase; it never replays the original Discord request or publishes private report content.

Trusted CI and eval detections skip semantic assessment only after their source-owned contract has been accepted. Deployment and runtime detections are observational and must first distinguish transient infrastructure behavior from a source defect. The reconciler then queues an idempotent `improvement_repair` task from the signal snapshot and active contract version. It uses the normal verified code-update pipeline, links work to the case when queued, and requests auto-merge for the diff-described PR. The durable work remains `in_progress` until GitHub reports the exact published head merged; a terminal check failure retires that PR and enters the bounded repair retry path. Drafts, changed heads, conflicts, requested changes, and unresolved review requirements are explicit operator blockers. Deployment proof—not task completion or PR publication—is the resolution gate.

## Repository pipeline

For the `repository` profile, the runner:

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

## Computer pipeline

For the `computer` profile, `src/execution/scratchTask.ts` creates an empty workspace, installs the profile's helpers, and runs NanoCodex with the scratch-task prompt. The agent drives everything through its ordinary shell and `view_image` tools:

- `agent-fetch <url>` (`src/execution/sandboxFetch.ts`) downloads one public file, rewriting Google Drive, Dropbox, and GitHub share links to direct downloads, with a size cap. A share host that answers with an HTML page is reported rather than saved.
- `agent-desktop` starts an Xvfb display and launches programs on it (Windows `.exe`/`.msi` through Wine), takes screenshots, lists windows, and sends mouse and keyboard input with xdotool.
- `agent-deliver <file>...` marks up to four files (usually screenshots) for the Discord reply. After the run, the runner uploads them as `result_file` binary artifacts; unsupported types are skipped without failing the task.

A clean, non-empty final answer is the outcome; no diff, branch, or PR is involved. Real-time games are played through short screenshot-act loops, so turn-based, puzzle, and menu-driven programs work best.

`src/execution/sandboxToolShims.ts` owns the intentionally small command surface injected into each profile. The pipeline installs those shims; feature behavior and callback authority remain in their canonical application owners.

## Context and documentation

`src/execution/contextPack.ts` gives the coding agent a compact map of current owners rather than copying historical plans or stale folder READMEs. Exact identifiers from the request are searched first. The first useful edit and closest test are preferred over broad repository archaeology.

The task request remains authoritative. Generated diagnoses, previous attempts, PR metadata, and retained logs provide context but must not replace the requested outcome.

## Git policy

- New automated branches use the `agent/` prefix.
- Branch suffixes hash the full durable task ID so unrelated retries cannot collide even when their human-readable endings match.
- Pushes to the configured base or protected branch names are refused.
- Existing open PR work may target its existing head branch only after the PR state is verified.
- A merged PR is immutable; follow-up work starts from current base and opens a new PR.
- PR titles and bodies describe the actual diff and user impact, not task IDs or generic validation metadata.
- PR bodies include verification and requester attribution without private Discord content.
- A PR is opened only for a real repository diff.

GitHub App installation credentials are preferred in production. A local PAT should be fine-grained and limited to the configured repository.

## Kubernetes isolation

Sandboxes run untrusted code, from dependency install scripts to member-supplied executables, so every profile shares one hardened boundary. Each Job pod:

- is pinned by `productConfig.sandbox.isolation` to the dedicated, tainted sandbox node pool;
- runs under the `gvisor` RuntimeClass with a low-priority class;
- runs as a non-root user with all capabilities dropped and no service-account token or service links;
- receives only public placeholders for the upstream credentials its profile declares. The in-cluster egress proxy swaps them for real credentials on verified TLS to the credential host.
- uses an egress tier chosen by profile (`productConfig.sandbox.egress`). The repository profile is labeled `credentialed` and may have GitHub and OpenRouter injected. The computer profile is labeled `model` and may have only its model credential injected, so a member-supplied program can never obtain GitHub authority.

The runner trusts the proxy CA through `NODE_EXTRA_CA_CERTS` and writes a combined bundle (`src/execution/sandboxEgress.ts`) for git, `gh`, curl, and NanoCodex.

Sandboxes never share a node with production Postgres.

This backend creates one Job, Secret, and ConfigMap per task. The worker service account can manage those resources and has read-only Pod and Pod-log access for failed-task diagnostics; the sandbox service account has no Kubernetes API permissions. Callback tokens bind task and sandbox-run identity, timestamp, and body. Terminal callbacks are accepted once. Before failed Job cleanup, reconciliation retains the pod phase, termination reason, exit code, signal, and restart count as typed task evidence, plus a bounded redacted log tail as a private runtime artifact.

A handled repository, code, verification, or publication failure sends its signed terminal callback and exits the container cleanly. An unhandled runner exit, eviction, resource kill, or lost terminal callback gets one Kubernetes pod retry under the same task identity. A failed first pod remains running work while that retry is active. If the retry is exhausted, reconciliation classifies the retained evidence as memory exhaustion, eviction, deadline, startup failure, runner crash, disappearance, or explicitly unknown before cleanup.

The sandbox pool deliberately runs one sandbox at a time across every profile. Increasing that limit requires dedicated measured capacity and durable admission; increasing worker replicas or relying on container limits alone must not reintroduce concurrent memory pressure.

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

Discord failure rendering includes command output only for a command with a non-zero exit. A last successful setup command is progress evidence, never a guessed failure cause. Infrastructure failures use the retained pod classification and keep raw Kubernetes wording and bounded logs in private Console/runtime evidence.

Members can add `🔄` or `🔃` to a terminal task update to queue a fresh retry. The reaction is durably deduplicated per member and target message, and the new task links back to the failed task. Tasks linked to an improvement case create a new source-independent work attempt while retaining the case projection; the case remains `in_progress` during the retry and still requires explicit deployed verification before resolution.

Report-authorized `improvement_report` tasks are two-phase. The first phase is evidence-only and must leave the checkout clean. Unsupported reports finish without GitHub work; insufficient evidence names the exact reporter clarification needed. A confirmed defect must include registered machine-executable checks before the second phase may edit. A successfully verified repair opens a diff-described PR and enables auto-merge after required checks; private report evidence never enters the branch, commit, or PR metadata.

Autonomous reassessment remains authoritative after a case becomes actionable: later proof that the incident recovered dismisses the stale case, while a specific unresolved ambiguity stops for operator judgment instead of consuming blind retries.
The health projection reports that ambiguity as blocked on operator judgment; read-only reconciliation may inspect an existing terminal assessment without requiring a queue producer.

Source-authorized `improvement_repair` tasks are single-phase because the trusted detector and active executable contract already establish the defect. They still require a real diff, focused coverage, full runner verification, diff-derived public PR metadata, required checks, and deployed contract proof. A missing contract, concrete ambiguity, unavailable worker, or exhausted retries is surfaced explicitly instead of silently waiting for human review.

## Operations and verification

Inspect task state through the canonical runtime ledger from a trusted, configured application environment. The sandbox callback receiver accepts writes only; it deliberately has no task-reading HTTP API.

For every repository task, task success means the PR was published, not that work completed. Generic reconciliation records the configured repository's exact PR state, head, merge revision, and merge time on the task projection; improvement reconciliation additionally observes checks and review state. Release promotion refreshes those PR snapshots before recording a verified deployment and attaches that deployment only to tasks whose exact merge revision shipped. If publication is first reconciled after its release was already verified, the same exact-revision lookup backfills the deployment identity and original verification time. The Console can therefore distinguish open, merged-awaiting-rollout, deployed, closed-without-merge, no-change, and failed outcomes for direct and improvement work without inferring from task completion. Only an actual merge moves an improvement case to deployed verification. Registered producers supply every accepted check: read-only private replay records hashed per-check conclusions and its canonical execution, durable promotion supplies release and canary gates, and production observation supplies traffic-sampled delivery and quality proof. Passed receipts resolve the case, failed receipts return it to `actionable`, and pending producers leave it `verifying` with an explicit retry trigger. Readiness, an operator-authored summary, or an operator-selected execution never substitutes for the active contract.

Changes to this lifecycle should test queue handoff, status rendering, context selection, branch policy, dependency refresh, callback authentication, terminal idempotency, cleanup, and publication metadata as relevant. Run `npm run verify`; run `npm run verify:db` for queue, task, or migration changes; run the appropriate smoke command only when credentials and external mutation are intentionally in scope.
