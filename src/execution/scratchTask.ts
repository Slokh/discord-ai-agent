import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { progress, recordResultFile } from "./callbacks.js";
import { scratchTaskPrompt } from "./codegenPrompts.js";
import { NANOCODEX_RUNTIME_LABEL } from "./harness/nanocodex.js";
import type { AgentRunSummary } from "./harness/types.js";
import { runNanoCodexPhase, timedPhase } from "./runnerPhases.js";
import type { SandboxEnv, TaskTimings } from "./sandboxEnv.js";
import { MAX_DELIVERED_FILES, writeSandboxToolShims } from "./sandboxToolShims.js";
import { conciseError } from "./sandboxUtils.js";

type CacheSummary = { toolShims?: string[] };

/**
 * Runs a task that has no repository: an empty scratch workspace, the
 * profile's helper commands, and the same harness, callbacks, and completion
 * contract as repository work.
 */
export async function runScratchTask(env: SandboxEnv, timings: TaskTimings, totalStartedAt: number) {
  const cacheSummary: CacheSummary = {};
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-task-"));
  const workspaceDir = path.join(workRoot, "workspace");
  const deliverDir = path.join(workRoot, "deliver");
  const toolShimDir = path.join(workRoot, "tool-shims");
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await timedPhase(env, timings, "toolShims", "Preparing the isolated workspace and its helper commands.", async () => {
      const shims = await writeSandboxToolShims(toolShimDir, env, {
        workspaceDir,
        deliverDir,
        fetchScript: path.join(path.dirname(fileURLToPath(import.meta.url)), "sandboxFetch.js"),
      });
      cacheSummary.toolShims = shims;
      await progress(env, "tool_shims_ready", "Sandbox helper tools are available for NanoCodex.", { toolShims: shims, harness: NANOCODEX_RUNTIME_LABEL });
    });
    const summary = await runNanoCodexPhase({
      env,
      timings,
      phase: "nanocodex",
      message: "Running NanoCodex in the isolated workspace.",
      input: {
        env,
        checkoutDir: workspaceDir,
        gitEnv: { ...process.env, HOME: workRoot },
        toolShimDir,
        prompt: scratchTaskPrompt({ ...env, workspaceDir }),
      },
    });
    await uploadDeliveredFiles(env, deliverDir);
    return await taskResultOutcome(env, summary, timings, totalStartedAt, cacheSummary);
  } finally {
    await progress(env, "cleanup", "Cleaning up the ephemeral sandbox workspace.").catch(() => undefined);
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Shared completion for profiles whose outcome is a reported result rather than a pull request. */
export async function taskResultOutcome<C>(
  env: SandboxEnv,
  summary: AgentRunSummary,
  timings: TaskTimings,
  totalStartedAt: number,
  cacheSummary: C,
) {
  const resultSummary = summary.attempts.at(-1)?.finalResponse?.trim();
  if (!resultSummary) throw new Error("The sandbox agent finished without a result.");
  timings.total = Date.now() - totalStartedAt;
  await progress(env, "result_complete", resultSummary, { taskType: env.taskType });
  return {
    status: "succeeded" as const,
    branchName: null,
    prUrl: null,
    draft: null,
    verifyPassed: true,
    updatedExistingPullRequest: false,
    improvementAssessment: null,
    autoMergeEnabled: false,
    headRevision: null,
    resultSummary,
    timings,
    cacheSummary
  };
}

const RESULT_FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
};

/** Uploads what the agent chose with `agent-deliver`; a rejected file never fails the task. */
export async function uploadDeliveredFiles(
  env: SandboxEnv,
  deliverDir: string,
  upload: typeof recordResultFile = recordResultFile,
) {
  const names = (await fs.readdir(deliverDir).catch(() => [] as string[])).sort().slice(0, MAX_DELIVERED_FILES);
  let delivered = 0;
  for (const [order, name] of names.entries()) {
    const contentType = RESULT_FILE_TYPES[path.extname(name).toLowerCase()];
    const displayName = name.replace(/^\d{2}-/, "");
    if (!contentType) {
      await progress(env, "result_file_skipped", `Skipped ${displayName}: unsupported attachment type.`).catch(() => undefined);
      continue;
    }
    try {
      await upload(env, { name: displayName, contentType, data: await fs.readFile(path.join(deliverDir, name)), order });
      delivered += 1;
    } catch (error) {
      await progress(env, "result_file_skipped", `Skipped ${displayName}: ${conciseError(error)}`).catch(() => undefined);
    }
  }
  await progress(env, "result_files", `Attached ${delivered} result file${delivered === 1 ? "" : "s"}.`, { delivered }).catch(() => undefined);
  return delivered;
}
