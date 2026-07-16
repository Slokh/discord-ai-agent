import fs from "node:fs/promises";
import path from "node:path";
import { progress, recordArtifact, recordCommand } from "../callbacks.js";
import { CodexAppServerClient, providerForModel, type CodexAppServerNotification } from "../codexAppServer.js";
import { codeUpdatePrompt, codeUpdateRecoveryPrompt } from "../codegenPrompts.js";
import { runCommand } from "../commands.js";
import { gitChangeStateMetadata, gitStatusPorcelain, readGitChangeState } from "../repoWorkspace.js";
import type { SandboxEnv } from "../sandboxEnv.js";
import {
  MAX_ACTIVITY_COMMAND_OUTPUT,
  MAX_CAPTURED_COMMAND_OUTPUT,
  MAX_RECOVERY_TAIL,
  compactJson,
  conciseError,
  formatDuration,
  jsonStringAt,
  numberValue,
  objectValue,
  sanitizeStepName,
  sha256,
  stringValue,
  tail,
  truncateSingleLine
} from "../sandboxUtils.js";
import { CodegenNoDiffError, type AgentAttemptSummary, type AgentRunSummary, type CodegenHarnessAdapter, type CodegenHarnessRunInput } from "./types.js";

const CODEX_APP_SERVER_MAX_ATTEMPTS = 2;
const CODEX_EXEC_FALLBACK_MAX_ATTEMPTS = 1;

type CodexAppServerAttemptResult = {
  exitCode: number;
  threadId?: string;
  terminalMethod?: string;
  durationMs: number;
  notifications: CodexAppServerNotification[];
  transcript: string;
  stderrTail: string;
  error?: string;
  startedTurn: boolean;
};

export class CodexAppServerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerStartupError";
  }
}

export const codexHarnessAdapter: CodegenHarnessAdapter = {
  name: "codex",
  artifactHarnessLabel: "codex-app-server",
  writeConfig: async (input) => {
    await writeCodexConfig(input.codexHome, input.checkoutDir, input.env);
  },
  run: (input) => runCodexWithRecovery(input)
};

export function codexHomePathForTask(input: { sandboxCacheDir: string; workRoot: string }) {
  const taskDir = path.basename(input.workRoot) || `task-${sha256(input.workRoot).slice(0, 10)}`;
  return path.join(input.sandboxCacheDir, "codex-home", taskDir);
}

function codexEnv(env: SandboxEnv, baseEnv: NodeJS.ProcessEnv, codexHome: string, toolShimDir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: codexHome,
    OPENROUTER_API_KEY: env.openRouterApiKey,
    PATH: `${toolShimDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ""}`,
    AGENT_TOOL_SHIM_DIR: toolShimDir
  };
}

export async function writeCodexConfig(codexHome: string, checkoutDir: string, env: SandboxEnv) {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), codexConfigToml({ checkoutDir, model: env.openRouterCodegenModel }), "utf8");
}

export function codexConfigToml(input: { checkoutDir: string; model: string }) {
  return [
    `model = ${JSON.stringify(input.model)}`,
    'model_provider = "openrouter"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'preferred_auth_method = "apikey"',
    'model_reasoning_effort = "low"',
    'model_verbosity = "low"',
    'personality = "pragmatic"',
    'service_tier = "fast"',
    "",
    "[features]",
    "fast_mode = true",
    "runtime_metrics = true",
    "",
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    `[projects.${JSON.stringify(input.checkoutDir)}]`,
    'trust_level = "trusted"',
    ""
  ].join("\n");
}

export async function runCodexWithRecovery(input: CodegenHarnessRunInput): Promise<AgentRunSummary> {
  try {
    return await runCodexAppServerWithRecovery(input);
  } catch (error) {
    if (error instanceof CodegenNoDiffError) {
      throw error;
    }
    const changeState = await readGitChangeState(input.checkoutDir, input.baseRevision).catch(() => undefined);
    const gitStatus = changeState?.status ?? "";
    if (changeState?.hasChanges) {
      await progress(input.env, "codex_app_server_salvaged_diff", "Codex app-server failed after producing code changes; continuing to PR creation.", {
        error: conciseError(error),
        ...gitChangeStateMetadata(changeState)
      });
      return {
        attempts: [
          {
            attempt: 1,
            command: "app-server",
            exitCode: 1,
            durationMs: 0,
            producedDiff: true,
            stderrTail: conciseError(error),
            stdoutTail: tail(gitStatus, MAX_RECOVERY_TAIL)
          }
        ]
      };
    }
    await progress(input.env, "codex_app_server_fallback", "Codex app-server could not start a usable turn; falling back to codex exec.", {
      error: conciseError(error)
    });
    return runCodexExecWithRecovery(input);
  }
}

async function runCodexAppServerWithRecovery(input: CodegenHarnessRunInput): Promise<AgentRunSummary> {
  const attempts: AgentAttemptSummary[] = [];
  const totalAttempts = CODEX_APP_SERVER_MAX_ATTEMPTS;
  let threadId: string | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? codeUpdatePrompt(input.env, input.contextPack)
        : codeUpdateRecoveryPrompt(input.env, {
            attempt,
            totalAttempts,
            attempts,
            gitStatus: await gitStatusPorcelain(input.checkoutDir).catch((error) => `Unable to read git status: ${conciseError(error)}`),
            contextPack: input.contextPack
          });
    await recordArtifact(input.env, {
      kind: "prompt",
      name: attempt === 1 ? "Codex app-server prompt" : `Codex app-server recovery prompt ${attempt}`,
      content: prompt,
      contentType: "text/plain",
      metadata: { model: input.env.openRouterCodegenModel, attempt, command: "app-server", harness: "codex-app-server", threadId }
    });
    await progress(input.env, `codex_app_server_attempt_${attempt}`, `Starting Codex app-server attempt ${attempt}/${totalAttempts}.`, {
      attempt,
      totalAttempts,
      model: input.env.openRouterCodegenModel,
      harness: "codex-app-server",
      threadId
    });
    const result = await runCodexAppServerAttempt({
      ...input,
      attempt,
      totalAttempts,
      prompt,
      threadId
    });
    threadId = result.threadId ?? threadId;
    const changeState = await readGitChangeState(input.checkoutDir, input.baseRevision).catch(() => undefined);
    const gitStatus = changeState?.status ?? "";
    const producedDiff = Boolean(changeState?.hasChanges);
    const summary: AgentAttemptSummary = {
      attempt,
      command: "app-server",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      producedDiff,
      stdoutTail: tail(result.transcript, MAX_RECOVERY_TAIL),
      stderrTail: tail([result.error, result.stderrTail].filter(Boolean).join("\n"), MAX_RECOVERY_TAIL)
    };
    attempts.push(summary);
    await progress(
      input.env,
      producedDiff ? `codex_app_server_attempt_${attempt}_diff` : `codex_app_server_attempt_${attempt}_no_diff`,
      producedDiff
        ? `Codex app-server attempt ${attempt} produced a code diff.`
        : `Codex app-server attempt ${attempt} finished without a code diff${attempt < totalAttempts ? "; retrying with a direct nudge." : "."}`,
      {
        attempt,
        totalAttempts,
        exitCode: result.exitCode,
        terminalMethod: result.terminalMethod,
        durationMs: result.durationMs,
        notificationCount: result.notifications.length,
        threadId,
        ...(changeState ? gitChangeStateMetadata(changeState) : { gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT) })
      }
    );

    if (producedDiff) return { attempts };
    if (!result.startedTurn && result.exitCode !== 143) {
      throw new CodexAppServerStartupError(
        [
          "Codex app-server failed before starting a usable model turn.",
          ...attempts.map(
            (attempt) =>
              `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}`
          )
        ].join("\n")
      );
    }
    if (attempt < totalAttempts) continue;
  }

  throw new CodegenNoDiffError(
    [
      "Agent task produced no diff after Codex app-server recovery attempts; no PR will be opened.",
      ...attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}`
      )
    ].join("\n"),
    attempts
  );
}

async function runCodexAppServerAttempt(input: CodegenHarnessRunInput & {
  attempt: number;
  totalAttempts: number;
  prompt: string;
  threadId?: string;
}): Promise<CodexAppServerAttemptResult> {
  const codexBinary = process.env.CODEX_BIN || "codex";
  const commandLine = `${codexBinary} app-server --listen stdio://`;
  const startedAt = Date.now();
  const notifications: CodexAppServerNotification[] = [];
  const transcriptLines: string[] = [];
  let threadId = input.threadId;
  let terminalMethod: string | undefined;
  let exitCode: number;
  let errorText = "";
  let reportedNotifications = 0;
  let startedTurn = false;
  const client = CodexAppServerClient.spawn({
    command: codexBinary,
    args: ["app-server", "--listen", "stdio://"],
    cwd: input.checkoutDir,
    env: codexEnv(input.env, input.gitEnv, input.codexHome, input.toolShimDir),
    model: input.env.openRouterCodegenModel,
    provider: providerForModel(input.env.openRouterCodegenModel),
    reasoningEffort: "low"
  });

  try {
    await client.initialize();
    threadId = threadId
      ? await client.resumeThread({ threadId, cwd: input.checkoutDir, provider: providerForModel(input.env.openRouterCodegenModel) })
      : await client.startThread({ cwd: input.checkoutDir, provider: providerForModel(input.env.openRouterCodegenModel) });
    await progress(input.env, "codex_app_server_thread", "Codex app-server thread is ready.", {
      threadId,
      attempt: input.attempt,
      resumed: Boolean(input.threadId)
    });
    const turn = await client.runTurn({
      threadId,
      text: input.prompt,
      model: input.env.openRouterCodegenModel,
      reasoningEffort: "low",
      onNotification: async (notification) => {
        notifications.push(notification);
        if (notification.method === "turn/started") startedTurn = true;
        const summary = codexNotificationSummary(notification);
        transcriptLines.push(formatCodexNotificationTranscriptLine(notification, summary));
        if (summary.report && reportedNotifications < 30) {
          reportedNotifications += 1;
          await progress(input.env, `codex_app_server_${sanitizeStepName(notification.method)}`, summary.message, {
            attempt: input.attempt,
            threadId,
            method: notification.method,
            ...summary.metadata
          }).catch(() => undefined);
        }
      }
    });
    terminalMethod = turn.terminalMethod;
    exitCode = terminalMethod === "turn/completed" ? 0 : 1;
  } catch (error) {
    errorText = conciseError(error);
    exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  const transcript = transcriptLines.join("\n");
  const stderrTail = client.stderrTail();
  await recordCommand(input.env, {
    step: `codex_app_server_attempt_${input.attempt}`,
    command: commandLine,
    exitCode,
    outputTail: tail(transcript, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail([errorText, stderrTail].filter(Boolean).join("\n"), MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs,
    metadata: {
      harness: "codex-app-server",
      threadId,
      terminalMethod,
      notificationCount: notifications.length
    }
  });
  await recordArtifact(input.env, {
    kind: "command_log",
    name: `Codex app-server attempt ${input.attempt} transcript`,
    content: [
      `$ ${commandLine}`,
      transcript,
      stderrTail ? `stderr:\n${stderrTail}` : "",
      errorText ? `error:\n${errorText}` : "",
      `[exit ${exitCode} in ${formatDuration(durationMs)}]`
    ]
      .filter(Boolean)
      .join("\n"),
    contentType: "application/jsonl",
    metadata: {
      harness: "codex-app-server",
      threadId,
      terminalMethod,
      notificationCount: notifications.length
    }
  });

  return {
    exitCode,
    threadId,
    terminalMethod,
    durationMs,
    notifications,
    transcript,
    stderrTail,
    error: errorText || undefined,
    startedTurn
  };
}

async function runCodexExecWithRecovery(input: CodegenHarnessRunInput): Promise<AgentRunSummary> {
  const attempts: AgentAttemptSummary[] = [];
  const codexBinary = process.env.CODEX_BIN || "codex";
  const totalAttempts = CODEX_EXEC_FALLBACK_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const command: AgentAttemptSummary["command"] = attempt === 1 ? "exec" : "resume";
    const prompt =
      attempt === 1
        ? codeUpdatePrompt(input.env, input.contextPack)
        : codeUpdateRecoveryPrompt(input.env, {
            attempt,
            totalAttempts,
            attempts,
            gitStatus: await gitStatusPorcelain(input.checkoutDir).catch((error) => `Unable to read git status: ${conciseError(error)}`),
            contextPack: input.contextPack
          });
    await recordArtifact(input.env, {
      kind: "prompt",
      name: attempt === 1 ? "Codex prompt" : `Codex recovery prompt ${attempt}`,
      content: prompt,
      contentType: "text/plain",
      metadata: { model: input.env.openRouterCodegenModel, attempt, command, harness: "codex-exec-json" }
    });
    await progress(input.env, `codex_attempt_${attempt}`, `Starting Codex ${command} attempt ${attempt}/${totalAttempts}.`, {
      attempt,
      totalAttempts,
      command,
      model: input.env.openRouterCodegenModel,
      harness: "codex-exec-json"
    });
    const result = await runCommand(codexBinary, codexAttemptArgs({ command, model: input.env.openRouterCodegenModel }), {
      cwd: input.checkoutDir,
      env: codexEnv(input.env, input.gitEnv, input.codexHome, input.toolShimDir),
      input: prompt,
      allowFailure: true,
      taskEnv: input.env,
      step: `codex_attempt_${attempt}`
    });
    const changeState = await readGitChangeState(input.checkoutDir, input.baseRevision).catch(() => undefined);
    const gitStatus = changeState?.status ?? "";
    const producedDiff = Boolean(changeState?.hasChanges);
    const summary: AgentAttemptSummary = {
      attempt,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      producedDiff,
      stdoutTail: tail(result.stdout, MAX_RECOVERY_TAIL),
      stderrTail: tail(result.stderr, MAX_RECOVERY_TAIL)
    };
    attempts.push(summary);
    await progress(
      input.env,
      producedDiff ? `codex_attempt_${attempt}_diff` : `codex_attempt_${attempt}_no_diff`,
      producedDiff
        ? `Codex attempt ${attempt} produced a code diff.`
        : `Codex attempt ${attempt} finished without a code diff${attempt < totalAttempts ? "; retrying with a direct nudge." : "."}`,
      {
        attempt,
        totalAttempts,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(changeState ? gitChangeStateMetadata(changeState) : { gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT) })
      }
    );

    if (producedDiff) return { attempts };
    if (attempt < totalAttempts) continue;
  }

  throw new CodegenNoDiffError(
    [
      "Agent task produced no diff after Codex recovery attempts; no PR will be opened.",
      ...attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}`
      )
    ].join("\n"),
    attempts
  );
}

export function codexExecArgs(input: { checkoutDir: string; model: string }) {
  return [
    "exec",
    "--json",
    "-C",
    input.checkoutDir,
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    input.model,
    "-"
  ];
}

export function codexResumeExecArgs(input: { model: string }) {
  return ["exec", "resume", "--last", "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", input.model, "-"];
}

function codexAttemptArgs(input: { command: "exec" | "resume"; model: string }) {
  return input.command === "exec" ? codexExecArgs({ checkoutDir: ".", model: input.model }) : codexResumeExecArgs({ model: input.model });
}

function codexNotificationSummary(notification: CodexAppServerNotification): {
  message: string;
  report: boolean;
  metadata: Record<string, unknown>;
} {
  const method = notification.method;
  const params = objectValue(notification.params) ?? objectValue(objectValue(notification.raw)?.params);
  const item = objectValue(params?.item);
  const itemType = stringValue(item?.type) ?? stringValue(params?.type);
  const itemId = stringValue(item?.id) ?? stringValue(params?.itemId);
  const command = stringValue(item?.command) ?? stringValue(params?.command) ?? stringValue(params?.cmd);
  const agentText = stringValue(item?.text) ?? stringValue(params?.text);
  const metadata: Record<string, unknown> = {
    itemType,
    itemId,
    command,
    paramsPreview: compactJson(notification.params)
  };
  if (method === "turn/started") return { message: "Codex turn started.", report: true, metadata };
  if (method === "turn/completed") return { message: "Codex turn completed.", report: true, metadata };
  if (method === "turn/failed") return { message: "Codex turn failed.", report: true, metadata };
  if (method === "error") {
    return {
      message: jsonStringAt(notification.raw, ["params", "error", "message"]) ?? "Codex app-server emitted an error.",
      report: true,
      metadata
    };
  }
  if (method === "item/started") {
    if (itemType === "commandExecution" && command) {
      return {
        message: `Codex is running: ${truncateSingleLine(command, 180)}`,
        report: true,
        metadata: { ...metadata, command }
      };
    }
    if (itemType === "reasoning") return { message: "Codex is reasoning through the change.", report: true, metadata };
    return { message: `Codex started ${itemType ?? "an item"}.`, report: true, metadata };
  }
  if (method === "item/completed") {
    if (itemType === "commandExecution" && command) {
      return {
        message: `Codex finished: ${truncateSingleLine(command, 180)}`,
        report: true,
        metadata: { ...metadata, command, status: stringValue(item?.status), exitCode: numberValue(item?.exitCode), durationMs: numberValue(item?.durationMs) }
      };
    }
    if (itemType === "agentMessage" && agentText) {
      return {
        message: `Codex reported: ${truncateSingleLine(agentText, 180)}`,
        report: true,
        metadata: { ...metadata, text: truncateSingleLine(agentText, 500) }
      };
    }
    return { message: `Codex completed ${itemType ?? "an item"}.`, report: true, metadata };
  }
  if (method === "turn/diff/updated") return { message: "Codex reported a diff update.", report: true, metadata };
  if (method === "thread/tokenUsage/updated") return { message: "Codex token usage updated.", report: true, metadata };
  if (method === "model/rerouted") return { message: "Codex rerouted the model.", report: true, metadata };
  return { message: `Codex notification: ${method}.`, report: false, metadata };
}

function formatCodexNotificationTranscriptLine(
  notification: CodexAppServerNotification,
  summary: ReturnType<typeof codexNotificationSummary>
) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    method: notification.method,
    message: summary.message,
    metadata: summary.metadata
  });
}
