import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { progress, recordArtifact, recordCommand } from "../callbacks.js";
import { codeUpdatePrompt } from "../codegenPrompts.js";
import { runCommand, type CommandResult } from "../commands.js";
import { gitChangeStateMetadata, readGitChangeState } from "../repoWorkspace.js";
import type { SandboxEnv } from "../sandboxEnv.js";
import {
  MAX_ACTIVITY_COMMAND_OUTPUT,
  MAX_CAPTURED_COMMAND_OUTPUT,
  MAX_RECOVERY_TAIL,
  conciseError,
  formatDuration,
  formatToolNameList,
  numberValue,
  objectValue,
  reserveLocalPort,
  sanitizeStepName,
  sleep,
  stringValue,
  tail,
  truncateSingleLine,
  uniqueStrings,
  waitForChildExit
} from "../sandboxUtils.js";
import { CodegenNoDiffError, type AgentAttemptSummary, type AgentRunSummary, type CodegenHarnessAdapter, type CodegenHarnessRunInput } from "./types.js";

const OPENCODE_HEALTH_PROBE_TIMEOUT_MS = 1_000;

type OpenCodeServerState = {
  child: ReturnType<typeof spawn>;
  serverUrl: string;
  commandLine: string;
  startedAt: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

export const openCodeHarnessAdapter: CodegenHarnessAdapter = {
  name: "opencode",
  artifactHarnessLabel: "opencode-server",
  writeConfig: async (input) => {
    await writeOpenCodeConfig(input.opencodeHome, input.env);
  },
  run: (input) => runOpenCodeWithRecovery(input)
};

export async function writeOpenCodeConfig(opencodeHome: string, env: Pick<SandboxEnv, "openRouterApiKey" | "openRouterCodegenModel">) {
  const dataHome = path.join(opencodeHome, ".local", "share");
  const authDir = path.join(dataHome, "opencode");
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    path.join(authDir, "auth.json"),
    JSON.stringify(
      {
        openrouter: {
          type: "api",
          key: env.openRouterApiKey
        }
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  await fs.writeFile(path.join(opencodeHome, "opencode.json"), openCodeConfigJson({ model: env.openRouterCodegenModel }), {
    encoding: "utf8",
    mode: 0o600
  });
}

export function openCodeConfigJson(input: { model: string }) {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: openCodeModelId(input.model)
    },
    null,
    2
  );
}

function openCodeEnv(env: SandboxEnv, baseEnv: NodeJS.ProcessEnv, opencodeHome: string, toolShimDir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HOME: opencodeHome,
    XDG_CONFIG_HOME: path.join(opencodeHome, ".config"),
    XDG_DATA_HOME: path.join(opencodeHome, ".local", "share"),
    OPENCODE_CONFIG: path.join(opencodeHome, "opencode.json"),
    OPENROUTER_API_KEY: env.openRouterApiKey,
    PATH: `${toolShimDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ""}`,
    AGENT_TOOL_SHIM_DIR: toolShimDir
  };
}

export function openCodeModelId(model: string) {
  return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
}

export function openCodeServeArgs(port: number) {
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
}

export function openCodeRunArgs(input: { serverUrl: string; checkoutDir: string; model: string; title: string; prompt: string }) {
  return [
    "run",
    "--attach",
    input.serverUrl,
    "--model",
    openCodeModelId(input.model),
    "--format",
    "json",
    "--title",
    input.title,
    input.prompt
  ];
}

export async function runOpenCodeWithRecovery(input: CodegenHarnessRunInput): Promise<AgentRunSummary> {
  const attempts: AgentAttemptSummary[] = [];
  const totalAttempts = 1;
  const attempt = 1;
  const prompt = codeUpdatePrompt(input.env, input.contextPack);
  await recordArtifact(input.env, {
    kind: "prompt",
    name: "OpenCode prompt",
    content: prompt,
    contentType: "text/plain",
    metadata: { model: openCodeModelId(input.env.openRouterCodegenModel), attempt, command: "opencode-run", harness: "opencode-server" }
  });
  await progress(input.env, "opencode_attempt_1", "Starting OpenCode server attempt 1/1.", {
    attempt,
    totalAttempts,
    command: "opencode-run",
    model: openCodeModelId(input.env.openRouterCodegenModel),
    harness: "opencode-server"
  });

  const result = await runOpenCodeServerAttempt({ ...input, attempt, totalAttempts, prompt });
  const changeState = await readGitChangeState(input.checkoutDir, input.baseRevision).catch(() => undefined);
  const gitStatus = changeState?.status ?? "";
  const producedDiff = Boolean(changeState?.hasChanges);
  const finalResponse = extractOpenCodeFinalText(result.stdout);
  const summary: AgentAttemptSummary = {
    attempt,
    command: "opencode-run",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    producedDiff,
    ...(finalResponse ? { finalResponse } : {}),
    stdoutTail: tail(result.stdout, MAX_RECOVERY_TAIL),
    stderrTail: tail(result.stderr, MAX_RECOVERY_TAIL)
  };
  attempts.push(summary);
  await progress(
    input.env,
    producedDiff ? "opencode_attempt_1_diff" : "opencode_attempt_1_no_diff",
    producedDiff ? "OpenCode attempt 1 produced a code diff." : "OpenCode attempt 1 finished without a code diff.",
    {
      attempt,
      totalAttempts,
      command: "opencode-run",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(changeState ? gitChangeStateMetadata(changeState) : { gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT) })
    }
  );

  if (producedDiff) return { attempts };
  throw new CodegenNoDiffError(
    [
      "Agent task produced no diff after OpenCode attempt; no PR will be opened.",
      ...attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}`
      )
    ].join("\n"),
    attempts
  );
}

async function runOpenCodeServerAttempt(input: CodegenHarnessRunInput & {
  attempt: number;
  totalAttempts: number;
  prompt: string;
}): Promise<CommandResult> {
  const opencodeBinary = process.env.OPENCODE_BIN || "opencode";
  const opencodeEnv = openCodeEnv(input.env, input.gitEnv, input.opencodeHome, input.toolShimDir);
  const server = await startOpenCodeServer({ env: input.env, binary: opencodeBinary, cwd: input.checkoutDir, opencodeEnv });
  try {
    await progress(input.env, "opencode_server_ready", "OpenCode server is ready.", {
      attempt: input.attempt,
      serverUrl: server.serverUrl
    });
    return await runCommand(opencodeBinary, openCodeRunArgs({
      serverUrl: server.serverUrl,
      checkoutDir: input.checkoutDir,
      model: input.env.openRouterCodegenModel,
      title: input.env.taskTitle,
      prompt: input.prompt
    }), {
      cwd: input.checkoutDir,
      env: opencodeEnv,
      allowFailure: true,
      taskEnv: input.env,
      step: `opencode_attempt_${input.attempt}`,
      displayCommand: `${opencodeBinary} run --attach ${server.serverUrl} --model ${openCodeModelId(input.env.openRouterCodegenModel)} --format json --title ${JSON.stringify(input.env.taskTitle)} [prompt]`,
      onStdoutText: createOpenCodeProgressObserver({ env: input.env, attempt: input.attempt, totalAttempts: input.totalAttempts })
    });
  } finally {
    await stopOpenCodeServer(input.env, server).catch((error) => {
      console.error("Failed to stop OpenCode server cleanly", error);
    });
  }
}

async function startOpenCodeServer(input: {
  env: SandboxEnv;
  binary: string;
  cwd: string;
  opencodeEnv: NodeJS.ProcessEnv;
}): Promise<OpenCodeServerState> {
  const port = await reserveLocalPort();
  const args = openCodeServeArgs(port);
  const serverUrl = `http://127.0.0.1:${port}`;
  const commandLine = `${input.binary} ${args.join(" ")}`;
  const startedAt = Date.now();
  const child = spawn(input.binary, args, {
    cwd: input.cwd,
    env: input.opencodeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state: OpenCodeServerState = {
    child,
    serverUrl,
    commandLine,
    startedAt,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    state.stdout += text;
    process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    state.stderr += text;
    process.stderr.write(text);
  });
  child.once("error", (error) => {
    state.error = conciseError(error);
  });
  child.once("exit", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });

  await progress(input.env, "opencode_server_start", "Starting OpenCode server.", {
    command: commandLine,
    serverUrl
  });
  try {
    await waitForOpenCodeServer(state);
    return state;
  } catch (error) {
    state.error = conciseError(error);
    await stopOpenCodeServer(input.env, state).catch(() => undefined);
    throw error;
  }
}

async function waitForOpenCodeServer(state: OpenCodeServerState, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (state.error) throw new Error(`OpenCode server failed to start: ${state.error}`);
    if (state.exitCode != null || state.signal != null) {
      throw new Error(`OpenCode server exited before it was ready: code=${state.exitCode ?? "null"} signal=${state.signal ?? "null"}`);
    }
    try {
      const response = await fetchOpenCodeHealth({ serverUrl: state.serverUrl });
      if (response.ok) return;
      lastError = `${response.status}: ${response.body}`;
    } catch (error) {
      lastError = conciseError(error);
    }
    await sleep(250);
  }
  throw new Error(`OpenCode server did not become healthy within ${formatDuration(timeoutMs)}${lastError ? `: ${lastError}` : ""}`);
}

export async function fetchOpenCodeHealth(input: { serverUrl: string; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? OPENCODE_HEALTH_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${input.serverUrl}/global/health`, { signal: controller.signal });
    return {
      ok: response.ok,
      status: response.status,
      body: response.ok ? "" : await response.text()
    };
  } catch (error) {
    if (timedOut) throw new Error(`OpenCode health probe timed out after ${formatDuration(timeoutMs)}.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function stopOpenCodeServer(env: SandboxEnv, state: OpenCodeServerState) {
  if (state.exitCode == null && state.signal == null) {
    state.child.kill("SIGTERM");
    await waitForChildExit(state.child, 5_000).catch(() => {
      if (state.exitCode == null && state.signal == null) state.child.kill("SIGKILL");
    });
  }
  const durationMs = Date.now() - state.startedAt;
  const exitCode = state.error ? 1 : 0;
  await recordCommand(env, {
    step: "opencode_server",
    command: state.commandLine,
    exitCode,
    outputTail: tail(state.stdout, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail([state.error, state.stderr].filter(Boolean).join("\n"), MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs,
    metadata: {
      harness: "opencode-server",
      serverUrl: state.serverUrl,
      processExitCode: state.exitCode,
      signal: state.signal
    }
  });
  await recordArtifact(env, {
    kind: "command_log",
    name: "OpenCode server log",
    content: [
      `$ ${state.commandLine}`,
      state.stdout.trimEnd(),
      state.stderr.trimEnd(),
      state.error ? `error:\n${state.error}` : "",
      `[stopped after ${formatDuration(durationMs)}]`
    ]
      .filter(Boolean)
      .join("\n"),
    contentType: "text/plain",
    metadata: {
      step: "opencode_server",
      harness: "opencode-server",
      serverUrl: state.serverUrl,
      processExitCode: state.exitCode,
      signal: state.signal
    }
  });
}

type OpenCodeOutputRecord = {
  type: string;
  timestamp: number;
  part: Record<string, unknown>;
};

function createOpenCodeProgressObserver(input: { env: SandboxEnv; attempt: number; totalAttempts: number }) {
  const state = {
    buffer: "",
    round: 0,
    firstTimestamp: null as number | null,
    firstEditReported: false,
    currentTools: [] as string[],
    emitted: new Set<string>()
  };

  const emit = (step: string, message: string, metadata: Record<string, unknown> = {}) => {
    const key = `${step}:${message}:${JSON.stringify(metadata).slice(0, 400)}`;
    if (state.emitted.has(key)) return;
    state.emitted.add(key);
    void progress(input.env, step, message, {
      attempt: input.attempt,
      totalAttempts: input.totalAttempts,
      harness: "opencode-server",
      ...metadata
    }).catch(() => undefined);
  };

  return (chunk: string) => {
    state.buffer += chunk;
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? "";
    for (const line of lines) {
      for (const record of parseOpenCodeOutputLine(line)) {
        state.firstTimestamp ??= record.timestamp;
        const durationMs = Math.max(0, record.timestamp - state.firstTimestamp);
        if (record.type === "step_start") {
          state.round += 1;
          state.currentTools = [];
          emit("opencode_round_started", `OpenCode started round ${state.round}.`, { round: state.round, durationMs });
          continue;
        }
        if (record.type === "tool_use") {
          const tool = openCodeToolProgressSummary(record.part);
          state.currentTools.push(tool.name);
          const step = `opencode_tool_${sanitizeStepName(tool.name)}`;
          emit(step, openCodeToolProgressMessage(tool), {
            round: state.round,
            tool: tool.name,
            status: tool.status,
            title: tool.title,
            output: tool.output,
            durationMs: tool.durationMs ?? durationMs
          });
          if (!state.firstEditReported && tool.name === "edit") {
            state.firstEditReported = true;
            emit("opencode_first_edit", "OpenCode made its first code edit.", {
              round: state.round,
              tool: tool.name,
              title: tool.title,
              durationMs
            });
          }
          continue;
        }
        if (record.type === "text") {
          const text = stringValue(objectValue(record.part.text)?.text) ?? stringValue(record.part.text) ?? stringValue(record.part.message);
          if (text) {
            emit("opencode_assistant_message", `OpenCode said: ${truncateSingleLine(text, 180)}`, {
              round: state.round,
              durationMs
            });
          }
          continue;
        }
        if (record.type === "step_finish") {
          const reason = stringValue(record.part.reason);
          const tools = uniqueStrings(state.currentTools);
          const message = tools.length
            ? `OpenCode finished round ${state.round} after ${formatToolNameList(tools)}.`
            : `OpenCode finished round ${state.round}.`;
          emit("opencode_round_finished", message, {
            round: state.round,
            reason,
            tools,
            tokens: objectValue(record.part.tokens),
            durationMs
          });
        }
      }
    }
  };
}

function parseOpenCodeOutputLine(line: string): OpenCodeOutputRecord[] {
  const index = line.indexOf('{"type"');
  if (index < 0) return [];
  try {
    const parsed = JSON.parse(line.slice(index)) as Record<string, unknown>;
    const type = stringValue(parsed.type);
    const timestamp = numberValue(parsed.timestamp);
    if (!type || timestamp == null) return [];
    return [{ type, timestamp, part: objectValue(parsed.part) ?? {} }];
  } catch {
    return [];
  }
}

export function extractOpenCodeFinalText(output: string) {
  let finalText = "";
  for (const line of output.split(/\r?\n/)) {
    for (const record of parseOpenCodeOutputLine(line)) {
      if (record.type !== "text") continue;
      const text = stringValue(record.part.text)?.trim();
      if (text) finalText = text;
    }
  }
  return finalText;
}

function openCodeToolProgressSummary(part: Record<string, unknown>) {
  const state = objectValue(part.state);
  const input = objectValue(state?.input);
  const time = objectValue(state?.time);
  const name = stringValue(part.tool) ?? "tool";
  const status = stringValue(state?.status);
  const title = stringValue(state?.title) ?? stringValue(input?.command) ?? stringValue(input?.filePath) ?? stringValue(input?.pattern) ?? "";
  const output = openCodeProgressOutput(name, stringValue(state?.output) ?? "");
  const startedAt = numberValue(time?.start);
  const endedAt = numberValue(time?.end);
  return {
    name,
    status,
    title,
    output,
    durationMs: startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : null
  };
}

function openCodeToolProgressMessage(tool: ReturnType<typeof openCodeToolProgressSummary>) {
  const title = tool.title ? ` ${truncateSingleLine(tool.title, 140)}` : "";
  if (tool.name === "edit") return `OpenCode is editing${title}.`;
  if (tool.name === "read") return `OpenCode is reading${title}.`;
  if (tool.name === "grep" || tool.name === "glob") return `OpenCode is searching${title}.`;
  if (tool.name === "bash") return `OpenCode is running${title}.`;
  return `OpenCode is using ${tool.name}${title}.`;
}

function openCodeProgressOutput(toolName: string, output: string) {
  if (!output.trim()) return "";
  if (toolName === "read") return "";
  if (toolName === "edit" && /edit applied successfully/i.test(output)) return "Edit applied successfully.";
  return truncateSingleLine(output, 220);
}
