import path from "node:path";
import { nanoCodexSessionId, runNanoCodexRuntime, type NanoCodexRuntimeEvent } from "../../agent/nanocodexRuntime.js";
import { CODEGEN_REASONING } from "../codegenSelection.js";
import { codegenNpmScriptEnv } from "../dependencyCache.js";
import { progress, recordArtifact } from "../callbacks.js";
import { codeUpdatePrompt } from "../codegenPrompts.js";
import { gitChangeStateMetadata, readGitChangeState } from "../repoWorkspace.js";
import type { SandboxEnv } from "../sandboxEnv.js";
import { MAX_RECOVERY_TAIL, formatDuration, sanitizeStepName, tail, truncateSingleLine } from "../sandboxUtils.js";
import { CodegenNoDiffError, type AgentAttemptSummary, type AgentRunSummary, type NanoCodexRunInput } from "./types.js";

export const NANOCODEX_RUNTIME_LABEL = "nanocodex-native-v1";

export function nanoCodexModel(model: string) {
  const normalized = model.trim().replace(/^openai\//, "");
  if (normalized === "gpt-5.6-sol" || normalized === "gpt-5.6-terra" || normalized === "gpt-5.6-luna") return normalized;
  throw new Error(
    `NanoCodex supports OpenRouter model "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", or "openai/gpt-5.6-luna"; received "${model}".`
  );
}

export function nanoCodexProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  toolShimDir: string,
): NodeJS.ProcessEnv {
  return {
    ...codegenNpmScriptEnv(baseEnv),
    PATH: `${toolShimDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ""}`,
    AGENT_TOOL_SHIM_DIR: toolShimDir,
  };
}

export async function runNanoCodex(input: NanoCodexRunInput): Promise<AgentRunSummary> {
  const attempt = input.attempt ?? 1;
  const totalAttempts = input.totalAttempts ?? 1;
  const model = nanoCodexModel(input.env.openRouterCodegenModel);
  const prompt = input.prompt ?? codeUpdatePrompt(input.env, input.contextPack);
  const startedAt = Date.now();
  const eventLines: string[] = [];
  let finalResponse: string | undefined;
  let stderr = "";
  let exitCode = 0;

  await recordArtifact(input.env, {
    kind: "prompt",
    name: "NanoCodex prompt",
    content: prompt,
    contentType: "text/plain",
    metadata: { model: `openai/${model}`, attempt, command: "nanocodex-run", harness: NANOCODEX_RUNTIME_LABEL }
  });
  await progress(input.env, "nanocodex_attempt_1", "Starting NanoCodex attempt 1/1.", {
    attempt,
    totalAttempts,
    command: "nanocodex-run",
    model: `openai/${model}`,
    harness: NANOCODEX_RUNTIME_LABEL
  });

  const observe = createNanoCodexProgressObserver({ env: input.env, attempt, totalAttempts });
  try {
    const result = await runNanoCodexRuntime({
      apiKey: input.env.openRouterApiKey,
      apiBaseUrl: input.env.openRouterBaseUrl || "https://openrouter.ai/api/v1",
      model: `openai/${model}`,
      thinking: CODEGEN_REASONING,
      reasoningMode: "standard",
      instructions: input.instructions ?? (input.env.taskType === "diagnosis"
        ? "Diagnose the request from repository and runtime evidence. Keep the checkout unchanged and return a concise evidence-backed result."
        : "Implement the requested repository change completely. Work directly in the provided checkout, follow its repository instructions, verify the result, and leave the working tree with the intended diff."),
      prompt,
      requestId: input.env.taskId,
      sessionId: nanoCodexSessionId(`code-update:${input.env.taskId}`),
      workspace: input.checkoutDir,
      workspaceTools: true,
      hostedWebSearch: false,
      tools: [],
      processCwd: input.checkoutDir,
      processEnv: nanoCodexProcessEnv(input.gitEnv, input.toolShimDir),
      executeTool: async (call) => ({
        success: false,
        output: `Unexpected application tool call ${call.name}; code updates use NanoCodex workspace tools only.`,
      }),
      onEvent: async (event) => {
        eventLines.push(JSON.stringify(event));
        await observe(event);
      },
    });
    finalResponse = result.finalMessage.trim() || undefined;
    await recordArtifact(input.env, {
      kind: "diagnostic",
      name: "NanoCodex session checkpoint",
      content: JSON.stringify(result.snapshot),
      contentType: "application/json",
      metadata: { harness: NANOCODEX_RUNTIME_LABEL, model: `openai/${model}`, usage: result.usage },
    });
  } catch (error) {
    exitCode = 1;
    stderr = error instanceof Error ? error.message : String(error);
  }

  const durationMs = Date.now() - startedAt;
  const changeState = await readGitChangeState(input.checkoutDir, input.baseRevision).catch(() => undefined);
  const producedDiff = Boolean(changeState?.hasChanges);
  const summary: AgentAttemptSummary = {
    attempt,
    command: "nanocodex-run",
    exitCode,
    durationMs,
    producedDiff,
    ...(finalResponse ? { finalResponse } : {}),
    stdoutTail: tail(eventLines.join("\n"), MAX_RECOVERY_TAIL),
    stderrTail: tail(stderr, MAX_RECOVERY_TAIL)
  };
  const attempts = [summary];

  await progress(
    input.env,
    producedDiff ? "nanocodex_attempt_1_diff" : "nanocodex_attempt_1_no_diff",
    producedDiff ? "NanoCodex attempt 1 produced a code diff." : "NanoCodex attempt 1 finished without a code diff.",
    {
      attempt,
      totalAttempts,
      command: "nanocodex-run",
      exitCode,
      durationMs,
      harness: NANOCODEX_RUNTIME_LABEL,
      ...(changeState ? gitChangeStateMetadata(changeState) : {})
    }
  );

  if (producedDiff || acceptsCleanNanoCodexResult(input.env.taskType, exitCode, finalResponse)) return { attempts };
  throw new CodegenNoDiffError(
    `Agent task produced no diff after NanoCodex attempt; no PR will be opened.\nattempt 1: exit=${exitCode}, duration=${formatDuration(durationMs)}`,
    attempts
  );
}

export function acceptsCleanNanoCodexResult(
  taskType: SandboxEnv["taskType"],
  exitCode: number,
  finalResponse?: string,
) {
  return (taskType === "diagnosis" || taskType === "improvement_report") && exitCode === 0 && Boolean(finalResponse?.trim());
}

function createNanoCodexProgressObserver(input: { env: SandboxEnv; attempt: number; totalAttempts: number }) {
  let firstEditReported = false;
  const emitted = new Set<string>();
  const emit = async (step: string, message: string, metadata: Record<string, unknown> = {}) => {
    const key = `${step}:${message}:${JSON.stringify(metadata).slice(0, 400)}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    await progress(input.env, step, message, {
      attempt: input.attempt,
      totalAttempts: input.totalAttempts,
      harness: NANOCODEX_RUNTIME_LABEL,
      ...metadata
    }).catch(() => undefined);
  };

  return async (event: NanoCodexRuntimeEvent) => {
    if (event.type === "tool.call") {
      const tool = stringValue(event.payload.tool) ?? "tool";
      await emit(`nanocodex_tool_${sanitizeStepName(tool)}`, `NanoCodex is using ${tool}.`, { tool });
      if (!firstEditReported && /(?:apply_patch|edit|write)/i.test(tool)) {
        firstEditReported = true;
        await emit("nanocodex_first_edit", "NanoCodex made its first code edit.", { tool });
      }
    } else if (event.type === "assistant.message") {
      const message = stringValue(event.payload.text)?.trim();
      if (message) await emit("nanocodex_assistant_message", `NanoCodex said: ${truncateSingleLine(message, 180)}`);
    } else if (event.type === "run.error") {
      const message = stringValue(event.payload.message)?.trim();
      if (message) await emit("nanocodex_run_error", `NanoCodex reported: ${truncateSingleLine(message, 180)}`);
    }
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
