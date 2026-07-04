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
  inputLinesArtifactId?: string | null;
  inputLines?: string[];
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
      warmSandboxUrl?: string | null;
      fetchImpl?: typeof fetch;
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {}

  async execute(input: AgentRuntimePromptExecutionInput): Promise<AgentResponse> {
    const request: SandboxPromptRequest = {
      envelope: input.turnEnvelope,
      ...(input.inputLines?.length ? { inputLines: input.inputLines } : {})
    };
    const startedAt = Date.now();
    const transport = this.options.warmSandboxUrl ? "http" : "child_process";
    const command = transport === "child_process" ? this.options.runnerCommand ?? resolveSandboxPromptRunnerCommand() : null;
    const inputLineCount = input.inputLines?.length ?? 0;
    await storeWarmSandboxArtifact(input, {
      protocolKind: "sandbox_prompt_request",
      name: "Warm sandbox prompt request",
      content: JSON.stringify(request, null, 2),
      metadata: {
        executor: this.name,
        transport,
        command: command?.command ?? null,
        args: command?.args ?? null,
        url: transport === "http" ? this.options.warmSandboxUrl : null,
        requestId: input.turnEnvelope.requestId,
        inputLinesArtifactId: input.inputLinesArtifactId ?? null,
        inputLineCount
      }
    });
    await recordWarmSandboxSpan(input, {
      status: "running",
      startedAt,
      metadata: {
        executor: this.name,
        transport,
        command: command?.command ?? null,
        args: command?.args ?? null,
        url: transport === "http" ? this.options.warmSandboxUrl : null,
        inputLinesArtifactId: input.inputLinesArtifactId ?? null,
        inputLineCount
      }
    });
    if (this.options.warmSandboxUrl) {
      return await this.executeRemote(input, request, startedAt);
    }
    if (!command) throw new Error("Warm sandbox child process command was not resolved.");
    return await this.executeChild(input, request, command, startedAt);
  }

  private async executeRemote(input: AgentRuntimePromptExecutionInput, request: SandboxPromptRequest, startedAt: number): Promise<AgentResponse> {
    const url = `${this.options.warmSandboxUrl}/execute`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`Warm sandbox HTTP request failed (${response.status}): ${responseText}`);
      }
      const serializedResponse = JSON.parse(responseText) as SandboxPromptResponse;
      return await this.completeWarmSandboxResponse(input, serializedResponse, startedAt, {
        transport: "http",
        url: this.options.warmSandboxUrl,
        httpStatus: response.status,
        responseBytes: Buffer.byteLength(responseText, "utf8")
      });
    } catch (error) {
      await recordWarmSandboxSpan(input, {
        status: "failed",
        startedAt,
        metadata: {
          executor: this.name,
          transport: "http",
          url: this.options.warmSandboxUrl,
          error: error instanceof Error ? error.message : String(error)
        }
      }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeChild(
    input: AgentRuntimePromptExecutionInput,
    request: SandboxPromptRequest,
    command: RunnerCommand,
    startedAt: number
  ): Promise<AgentResponse> {
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
          metadata: { executor: this.name, transport: "child_process", error: `Timed out after ${input.timeoutMs}ms.`, stderrTail: stderr || null }
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
          metadata: { executor: this.name, transport: "child_process", error: error.message, stderrTail: stderr || null }
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
              transport: "child_process",
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
          this.completeWarmSandboxResponse(input, serializedResponse, startedAt, {
            transport: "child_process",
            stdoutBytes: Buffer.byteLength(stdout, "utf8"),
            stderrBytes: Buffer.byteLength(stderr, "utf8")
          })
            .then(resolve)
            .catch(reject);
        } catch (error) {
          recordWarmSandboxSpan(input, {
            status: "failed",
            startedAt,
            metadata: {
              executor: this.name,
              transport: "child_process",
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

  private async completeWarmSandboxResponse(
    input: AgentRuntimePromptExecutionInput,
    serializedResponse: SandboxPromptResponse,
    startedAt: number,
    metadata: Record<string, unknown>
  ): Promise<AgentResponse> {
    const response = deserializeAgentResponse(serializedResponse);
    await Promise.all([
      storeWarmSandboxArtifact(input, {
        protocolKind: "sandbox_prompt_response",
        name: "Warm sandbox prompt response",
        content: JSON.stringify(serializedResponse, null, 2),
        metadata: {
          executor: this.name,
          ...metadata,
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
          ...metadata,
          responseChars: response.content.length,
          fileCount: response.files?.length ?? 0,
          memoryEventCount: response.memoryEvents?.length ?? 0
        }
      })
    ]);
    return response;
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
