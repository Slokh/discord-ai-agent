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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
