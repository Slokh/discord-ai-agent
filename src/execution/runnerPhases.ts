import { progress, recordArtifact } from "./callbacks.js";
import { categoryForCodegenPhase, CodegenTaskError } from "./codegenFailureDiagnosis.js";
import { NANOCODEX_RUNTIME_LABEL, nanoCodexModel, runNanoCodex } from "./harness/nanocodex.js";
import type { AgentRunSummary, NanoCodexRunInput } from "./harness/types.js";
import type { SandboxEnv, TaskTimings } from "./sandboxEnv.js";
import { conciseError, formatDuration } from "./sandboxUtils.js";

/** Timed, callback-reported runner phases shared by every sandbox profile. */
export async function timedPhase<T>(
  env: SandboxEnv,
  timings: TaskTimings,
  step: string,
  message: string,
  run: () => Promise<T>,
  metadata: Record<string, unknown> = {}
): Promise<T> {
  await progress(env, step, message, metadata);
  const startedAt = Date.now();
  try {
    const result = await run();
    const durationMs = Date.now() - startedAt;
    timings[step] = durationMs;
    await progress(env, `${step}_complete`, `Finished ${step} in ${formatDuration(durationMs)}.`, { ...metadata, durationMs });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    timings[step] = durationMs;
    await progress(env, `${step}_failed`, `${step} failed after ${formatDuration(durationMs)}.`, {
      ...metadata,
      durationMs,
      error: conciseError(error)
    }).catch(() => undefined);
    if (error instanceof CodegenTaskError || (error instanceof Error && error.name === "CodegenNoDiffError")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CodegenTaskError(categoryForCodegenPhase(step), step, message, { cause: error });
  }
}

export async function runNanoCodexPhase(input: {
  env: SandboxEnv;
  timings: TaskTimings;
  input: NanoCodexRunInput;
  phase?: string;
  message?: string;
}) {
  const phase = input.phase ?? "nanocodex";
  return timedPhase(
    input.env,
    input.timings,
    phase,
    input.message ?? "Running NanoCodex to implement the requested change.",
    async () => {
      const summary = await runNanoCodex(input.input);
      await recordAgentAttemptSummary(input.env, `NanoCodex ${phase.replaceAll("_", " ")} summary`, summary);
      return summary;
    },
    { model: `openai/${nanoCodexModel(input.env.openRouterCodegenModel)}`, harness: NANOCODEX_RUNTIME_LABEL }
  );
}

async function recordAgentAttemptSummary(env: SandboxEnv, name: string, summary: AgentRunSummary) {
  await recordArtifact(env, {
    kind: "diagnostic",
    name,
    content: JSON.stringify(summary, null, 2),
    contentType: "application/json",
    metadata: {
      harness: NANOCODEX_RUNTIME_LABEL,
      attempts: summary.attempts.length,
      producedDiff: summary.attempts.some((attempt) => attempt.producedDiff)
    }
  });
}
