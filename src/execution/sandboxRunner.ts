/**
 * Sandbox runner entrypoint and compatibility facade.
 *
 * This file is executed directly inside the codegen sandbox
 * (`node dist/src/execution/sandboxRunner.js`). The implementation lives in
 * focused modules:
 *
 * - `runnerPipeline.ts`: code-update orchestration (`main`/`runCodeUpdate`).
 * - `repoWorkspace.ts`: mirror/worktree/branch/git state/push.
 * - `dependencyCache.ts`: install/restore/manifest dependency cache.
 * - `contextPack.ts`: codegen request context building.
 * - `harness/codex.ts` + `harness/opencode.ts`: harness adapters.
 * - `callbacks.ts` + `commands.ts`: control-plane callbacks and command runs.
 */
import { main } from "./runnerPipeline.js";

export { codeUpdatePrompt, codeUpdateRecoveryPrompt, renderCodegenContextPack } from "./codegenPrompts.js";
export { diagnoseCodegenFailure, renderCodegenFailureDiagnosis, type CodegenFailureDiagnosis } from "./codegenFailureDiagnosis.js";
export { codeUpdateBranchName, codeUpdatePullRequestBody, codeUpdatePullRequestTitle } from "./prFormatting.js";

export { buildCodegenContextPack, type CodegenContextPack } from "./contextPack.js";
export {
  changedDependencyManifestFiles,
  codegenNpmInstallEnv,
  codegenNpmScriptEnv,
  dependencyCacheKey,
  prepareDependencies,
  readDependencyManifestState
} from "./dependencyCache.js";
export { codexConfigToml, codexExecArgs, codexHomePathForTask, codexResumeExecArgs, runCodexWithRecovery } from "./harness/codex.js";
export {
  extractOpenCodeFinalText,
  fetchOpenCodeHealth,
  openCodeConfigJson,
  openCodeModelId,
  openCodeRunArgs,
  openCodeServeArgs,
  runOpenCodeWithRecovery
} from "./harness/opencode.js";
export {
  CodegenNoDiffError,
  type AgentAttemptSummary,
  type AgentRunSummary,
  type CodegenHarness,
  type CodegenHarnessAdapter,
  type CodexAttemptSummary
} from "./harness/types.js";
export {
  assertCodeUpdatePushAllowed,
  branchPushRef,
  codeUpdateTargetFromInputs,
  readGitChangeState,
  repairWorktreeRemoteForBranchPush,
  type CodeUpdateTarget,
  type GitChangeState
} from "./repoWorkspace.js";
export { loadSandboxEnv, type SandboxEnv, type TaskTimings } from "./sandboxEnv.js";
export { main, runCodeUpdate, writeSandboxToolShims } from "./runnerPipeline.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
