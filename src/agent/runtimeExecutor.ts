import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentRuntimeTurnEnvelope } from "./runtimeEnvelope.js";
import { executeInProcessAgentRuntime } from "./inProcessRuntimeExecutor.js";
import { deserializeAgentResponse, type SandboxPromptRequest, type SandboxPromptResponse } from "./sandboxPromptProtocol.js";

const CHILD_OUTPUT_TAIL_CHARS = 16_000;

export type AgentRuntimePromptExecutionInput = {
  toolContext: ToolContext;
  text: string;
  timeoutMs: number;
  turnEnvelope: AgentRuntimeTurnEnvelope;
};

export type AgentRuntimePromptExecutor = {
  name: string;
  execute: (input: AgentRuntimePromptExecutionInput) => Promise<AgentResponse>;
};

export class InProcessAgentRuntimePromptExecutor implements AgentRuntimePromptExecutor {
  readonly name = "in-process";

  async execute(input: AgentRuntimePromptExecutionInput): Promise<AgentResponse> {
    return executeInProcessAgentRuntime({
      toolContext: input.toolContext,
      text: input.text,
      timeoutMs: input.timeoutMs
    });
  }
}

export class WarmSandboxAgentRuntimePromptExecutor implements AgentRuntimePromptExecutor {
  readonly name = "warm-sandbox";

  constructor(
    private readonly options: {
      spawnProcess?: SpawnAgentProcess;
      runnerCommand?: RunnerCommand;
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {}

  async execute(input: AgentRuntimePromptExecutionInput): Promise<AgentResponse> {
    const command = this.options.runnerCommand ?? resolveSandboxPromptRunnerCommand();
    const request: SandboxPromptRequest = { envelope: input.turnEnvelope };
    const startedAt = Date.now();
    await storeWarmSandboxArtifact(input, {
      protocolKind: "sandbox_prompt_request",
      name: "Warm sandbox prompt request",
      content: JSON.stringify(request, null, 2),
      metadata: {
        executor: this.name,
        command: command.command,
        args: command.args,
        requestId: input.turnEnvelope.requestId
      }
    });
    await recordWarmSandboxSpan(input, {
      status: "running",
      startedAt,
      metadata: {
        executor: this.name,
        command: command.command,
        args: command.args
      }
    });
    const child = (this.options.spawnProcess ?? spawnAgentProcess)(command.command, command.args, {
      env: {
        ...process.env,
        ...this.options.env,
        LOG_LEVEL: "silent"
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    return await new Promise<AgentResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        recordWarmSandboxSpan(input, {
          status: "failed",
          startedAt,
          metadata: { executor: this.name, error: `Timed out after ${input.timeoutMs}ms.`, stderrTail: stderr || null }
        }).catch(() => undefined);
        reject(new Error(`Warm sandbox agent runtime execution timed out after ${input.timeoutMs}ms.`));
      }, input.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout = tail(`${stdout}${String(chunk)}`);
      });
      child.stderr.on("data", (chunk) => {
        stderr = tail(`${stderr}${String(chunk)}`);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recordWarmSandboxSpan(input, {
          status: "failed",
          startedAt,
          metadata: { executor: this.name, error: error.message, stderrTail: stderr || null }
        }).catch(() => undefined);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          recordWarmSandboxSpan(input, {
            status: "failed",
            startedAt,
            metadata: {
              executor: this.name,
              exitCode: code,
              signal,
              stdoutTail: stdout || null,
              stderrTail: stderr || null
            }
          }).catch(() => undefined);
          reject(
            new Error(
              `Warm sandbox agent runtime exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderr ? `: ${stderr.trim()}` : "."}`
            )
          );
          return;
        }
        try {
          const serializedResponse = parseSandboxPromptResponse(stdout);
          const response = deserializeAgentResponse(serializedResponse);
          Promise.all([
            storeWarmSandboxArtifact(input, {
              protocolKind: "sandbox_prompt_response",
              name: "Warm sandbox prompt response",
              content: JSON.stringify(serializedResponse, null, 2),
              metadata: {
                executor: this.name,
                responseChars: response.content.length,
                fileCount: response.files?.length ?? 0,
                memoryEventCount: response.memoryEvents?.length ?? 0
              }
            }),
            recordWarmSandboxSpan(input, {
              status: "succeeded",
              startedAt,
              metadata: {
                executor: this.name,
                responseChars: response.content.length,
                fileCount: response.files?.length ?? 0,
                memoryEventCount: response.memoryEvents?.length ?? 0,
                stdoutBytes: Buffer.byteLength(stdout, "utf8"),
                stderrBytes: Buffer.byteLength(stderr, "utf8")
              }
            })
          ])
            .then(() => resolve(response))
            .catch(reject);
        } catch (error) {
          recordWarmSandboxSpan(input, {
            status: "failed",
            startedAt,
            metadata: {
              executor: this.name,
              error: error instanceof Error ? error.message : String(error),
              stdoutTail: stdout || null,
              stderrTail: stderr || null
            }
          }).catch(() => undefined);
          reject(
            new Error(
              `Warm sandbox agent runtime returned invalid response after ${Date.now() - startedAt}ms: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

async function storeWarmSandboxArtifact(
  input: AgentRuntimePromptExecutionInput,
  artifact: { protocolKind: string; name: string; content: string; metadata?: Record<string, unknown> }
) {
  if (!input.toolContext.requestId) return;
  await input.toolContext.repo.storeProcessRunArtifact({
    runId: input.toolContext.requestId,
    kind: "raw_json",
    name: artifact.name,
    content: artifact.content,
    contentType: "application/json",
    metadata: {
      executor: "warm-sandbox",
      protocolKind: artifact.protocolKind,
      ...(artifact.metadata ?? {})
    }
  });
}

async function recordWarmSandboxSpan(
  input: AgentRuntimePromptExecutionInput,
  span: {
    status: "running" | "succeeded" | "failed";
    startedAt: number;
    metadata?: Record<string, unknown>;
  }
) {
  if (!input.toolContext.requestId) return;
  await input.toolContext.repo.recordProcessRunSpan({
    runId: input.toolContext.requestId,
    spanId: "agent.executor.warm_sandbox",
    name: "Warm sandbox prompt runner",
    status: span.status,
    startedAt: new Date(span.startedAt),
    completedAt: span.status === "running" ? undefined : new Date(),
    durationMs: span.status === "running" ? undefined : Math.max(0, Date.now() - span.startedAt),
    metadata: span.metadata
  });
}

type RunnerCommand = {
  command: string;
  args: string[];
};

type SpawnAgentProcess = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv }
) => Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "on" | "kill">;

function spawnAgentProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
  return spawn(command, args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function resolveSandboxPromptRunnerCommand(): RunnerCommand {
  const jsPath = fileURLToPath(new URL("./sandboxPromptRunner.js", import.meta.url));
  if (existsSync(jsPath)) {
    return { command: process.execPath, args: [jsPath] };
  }
  const tsPath = jsPath.replace(/\.js$/, ".ts");
  return { command: process.execPath, args: ["--import", "tsx", tsPath] };
}

function parseSandboxPromptResponse(stdout: string): SandboxPromptResponse {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("empty stdout");
  return JSON.parse(line) as SandboxPromptResponse;
}

function tail(text: string) {
  return text.length > CHILD_OUTPUT_TAIL_CHARS ? text.slice(-CHILD_OUTPUT_TAIL_CHARS) : text;
}
