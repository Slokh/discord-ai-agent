# Execution Domain

Owns sandboxed code-update execution from queued task to PR.

## Responsibilities

- Backend selection and sandbox launch.
- Repository checkout, branch names, dependency cache, git operations, scan/test commands, push, and PR body/title.
- Codex and OpenCode harness configuration, prompts, transcripts, recovery, and failure diagnosis.
- Codegen repository navigation context and exact request anchors.
- Task progress callbacks, command artifacts, and terminal output capture.

## Module Map

- `sandboxRunner.ts`: sandbox entrypoint and compatibility facade; re-exports the public runner API.
- `runnerPipeline.ts`: `main`/`runCodeUpdate` orchestration, timed phases, tool shims, harness selection.
- `repoWorkspace.ts`: cached mirror/worktree, target branch/PR resolution, git state, push refs, git auth.
- `dependencyCache.ts`: dependency cache key, node_modules restore/install, npm env scrubbing.
- `contextPack.ts`: codegen request context (repo guide excerpt, anchors, project map, check commands).
- `harness/types.ts`: `CodegenHarness`, `AgentAttemptSummary`, `AgentRunSummary`, `CodegenNoDiffError`, `CodegenHarnessRunInput`, `CodegenHarnessConfigInput`, and `CodegenHarnessAdapter`.
- `harness/codex.ts` + `harness/opencode.ts`: harness adapters (config, run/recovery, output parsing).
- `callbacks.ts`: control-plane progress/complete/command/artifact callbacks.
- `commands.ts`: sandbox command execution with output capture and activity events.
- `sandboxEnv.ts`: `SandboxEnv` loading and GitHub repository parsing.
- `sandboxUtils.ts`: small shared helpers (hashing, tails, locks, ports, process waits).

## Change Routing

- Codegen latency usually starts in repository navigation quality, first-edit latency, harness round count, cache hit/miss state, and repeated reads.
- PR title/body/branch formatting belongs here, not in Discord or tool registry.
- Request anchor extraction and exact-match target-file ranking live in `codegenAnchors.ts`.
- Failure classification and diagnostic text live in `codegenFailureDiagnosis.ts`; runner code only records the diagnosis as progress/artifacts.
- Initial and recovery coding-agent prompt text lives in `codegenPrompts.ts`; keep it short, generic, and architecture-driven.
- Avoid production request classifiers that choose a lifecycle for the agent. Prefer exact anchors plus clear repo/folder ownership docs so the coding agent can decide the implementation path.
- PR branch/title/body formatting lives in `prFormatting.ts`.
- Kubernetes/local-process launch behavior belongs in `backend.ts` and the queue/reconciler callers.
- Prompt changes should stay generic and architecture-driven; prefer clearer repo ownership over adding task-specific prompt instructions.

## Sandbox launch and callbacks

- Callback bearer tokens are HMAC tokens over `taskId`, `sandboxRunId`, and `issuedAt`. Every callback also sends `x-agent-task-timestamp` and `x-agent-task-signature`, where the signature is `HMAC(TASK_SIGNING_SECRET, timestamp + "." + rawBody)`. Progress, command, artifact, and terminal callback bodies must include the matching `sandboxRunId`.
- The internal API rejects progress callbacks after a task is terminal. Terminal callbacks are accepted idempotently after a task is already terminal, but the repository status guards prevent duplicate state transitions/events.
- Kubernetes job names are deterministic from `taskId`; the queue passes a `recordSandboxRun` hook so `backend.ts` records the sandbox run before creating Kubernetes Secrets, ConfigMaps, or Jobs. The worker skips launch when an active sandbox run already exists for the task.
- The reconciler asks the Kubernetes backend to sweep sandbox Jobs, Secrets, and ConfigMaps labeled `discord-ai-agent/task-id`; resources whose task id is not present in known sandbox runs are deleted.
- `githubAuth.ts` resolves the sandbox GitHub credential. Shared deployments should use GitHub App installation tokens scoped to `GITHUB_REPOSITORY`; local `GITHUB_TOKEN` fallback should be a fine-grained, single-repository PAT.

## Tests

- Sandbox prompt/config/git/context behavior: `tests/unit/sandbox-runner.test.ts`.
- Backend behavior: `tests/unit/kubernetes-backend.test.ts`.
- Local smoke: `npm run smoke:codegen -- --harness opencode --close-pr`.
