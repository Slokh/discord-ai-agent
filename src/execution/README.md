# Execution Domain

Owns sandboxed code-update execution from queued task to PR.

## Responsibilities

- Backend selection and sandbox launch.
- Repository checkout, branch names, dependency cache, git operations, scan/test commands, push, and PR body/title.
- Codex and OpenCode harness configuration, prompts, transcripts, recovery, and failure diagnosis.
- Codegen repository navigation context and exact request anchors.
- Task progress callbacks, command artifacts, and terminal output capture.

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

## Tests

- Sandbox prompt/config/git/context behavior: `tests/unit/sandbox-runner.test.ts`.
- Backend behavior: `tests/unit/kubernetes-backend.test.ts`.
- Local smoke: `npm run smoke:codegen -- --harness opencode --close-pr`.

## Migration Direction

Keep `src/execution/sandboxRunner.ts` as a compatibility facade. New implementation should move into focused modules for context, prompts, harnesses, git/cache, artifacts, diagnostics, and PR packaging.
