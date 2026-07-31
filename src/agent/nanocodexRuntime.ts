import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { FunctionToolDefinition } from "../models/openrouter.js";

export const NANOCODEX_RUNTIME_PROTOCOL_VERSION = 1;
export const NANOCODEX_RUNTIME_BINARY = "discord-agent-nanocodex-runtime";

export type NanoCodexModel = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
export type NanoCodexThinking = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type NanoCodexReasoningMode = "standard" | "pro";

export type NanoCodexSessionSnapshot = {
  version: number;
  model: string;
  lineage_id: string;
  prompt_cache_key: string;
  workspace: string;
  request_prefix?: Record<string, unknown>[];
  canonical_context: Record<string, unknown>;
  history: Record<string, unknown>[];
};

export type NanoCodexRuntimeEvent = {
  protocol_version: number;
  request_id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export type NanoCodexRuntimeToolResult = {
  success: boolean;
  output: string | Array<Record<string, unknown>>;
  codeModeValue?: unknown;
  metadata?: Record<string, unknown>;
};

export type NanoCodexRuntimeResult = {
  finalMessage: string;
  usage: Record<string, unknown>;
  snapshot: NanoCodexSessionSnapshot;
};

type RuntimeInput = {
  type: "run";
  request_id: string;
  api_key: string;
  api_base_url: string;
  model: NanoCodexModel;
  model_id_prefix: string;
  thinking: NanoCodexThinking;
  reasoning_mode: NanoCodexReasoningMode;
  fast_mode: boolean;
  hosted_web_search: boolean;
  workspace_tools: boolean;
  instructions: string;
  prompt: string;
  session_id: string;
  workspace?: string;
  resume?: NanoCodexSessionSnapshot;
  tools: NanoCodexToolDefinition[];
};

type NanoCodexToolDefinition = {
  type: "function";
  name: string;
  description: string;
  strict: boolean;
  parameters: Record<string, unknown>;
};

type RuntimeOutput =
  | { type: "ready"; protocol_version: number }
  | { type: "event"; protocol_version: number; request_id: string; event: NanoCodexRuntimeEvent }
  | {
      type: "tool_call";
      protocol_version: number;
      request_id: string;
      session_id: string;
      call_id: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "completed";
      protocol_version: number;
      request_id: string;
      final_message: string;
      usage: Record<string, unknown>;
      snapshot: NanoCodexSessionSnapshot;
    }
  | { type: "failed"; protocol_version: number; request_id?: string; error: string };

type RuntimeProcess = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "once" | "kill">;

export async function runNanoCodexRuntime(input: {
  binary?: string;
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  thinking: NanoCodexThinking;
  reasoningMode?: NanoCodexReasoningMode;
  fastMode?: boolean;
  hostedWebSearch?: boolean;
  instructions: string;
  prompt: string;
  requestId: string;
  sessionId: string;
  workspace?: string;
  workspaceTools?: boolean;
  resume?: NanoCodexSessionSnapshot;
  tools: FunctionToolDefinition[];
  executeTool: (call: { callId: string; name: string; arguments: unknown }) => Promise<NanoCodexRuntimeToolResult>;
  onEvent?: (event: NanoCodexRuntimeEvent) => void | Promise<void>;
  onProgress?: () => void;
  abortSignal?: AbortSignal;
  processCwd?: string;
  processEnv?: NodeJS.ProcessEnv;
  spawnProcess?: (binary: string, options: { cwd?: string; env?: NodeJS.ProcessEnv }) => RuntimeProcess;
}): Promise<NanoCodexRuntimeResult> {
  const child = (input.spawnProcess ?? spawnRuntimeProcess)(input.binary ?? NANOCODEX_RUNTIME_BINARY, {
    cwd: input.processCwd,
    env: input.processEnv,
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => boundedPush(stderr, String(chunk), 32_000));

  const lines = createInterface({ input: child.stdout });
  const abort = () => child.kill("SIGTERM");
  if (input.abortSignal?.aborted) abort();
  input.abortSignal?.addEventListener("abort", abort, { once: true });

  return await new Promise<NanoCodexRuntimeResult>((resolve, reject) => {
    let settled = false;
    let started = false;
    let queue = Promise.resolve();

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      input.abortSignal?.removeEventListener("abort", abort);
      lines.close();
      operation();
    };
    const fail = (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    const send = (message: unknown) => {
      if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
        child.stdin.once("drain", input.onProgress ?? (() => {}));
      }
    };

    lines.on("line", (line) => {
      queue = queue.then(async () => {
        const message = parseRuntimeOutput(line);
        assertRuntimeProtocol(message);
        input.onProgress?.();
        switch (message.type) {
          case "ready":
            if (started) throw new Error("NanoCodex runtime emitted ready more than once");
            started = true;
            send(runInput(input));
            return;
          case "event":
            assertRequestId(input.requestId, message.request_id);
            await input.onEvent?.(message.event);
            return;
          case "tool_call": {
            assertRequestId(input.requestId, message.request_id);
            const result = await input.executeTool({
              callId: message.call_id,
              name: message.name,
              arguments: message.arguments,
            });
            send({
              type: "tool_result",
              call_id: message.call_id,
              success: result.success,
              output: result.output,
              ...(result.codeModeValue === undefined ? {} : { code_mode_value: result.codeModeValue }),
              ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
            });
            return;
          }
          case "completed":
            assertRequestId(input.requestId, message.request_id);
            finish(() => resolve({
              finalMessage: message.final_message,
              usage: message.usage,
              snapshot: message.snapshot,
            }));
            return;
          case "failed":
            if (message.request_id) assertRequestId(input.requestId, message.request_id);
            throw new Error(`NanoCodex runtime failed: ${message.error}`);
        }
      }).catch(fail);
    });
    lines.once("close", () => {
      void queue.finally(() => {
        if (!settled) fail(new Error("NanoCodex runtime closed before a terminal message"));
      });
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (settled) return;
      const diagnostic = stderr.join("").trim();
      fail(new Error([
        `NanoCodex runtime exited before completion (code=${code ?? "none"}, signal=${signal ?? "none"})`,
        diagnostic ? `stderr: ${diagnostic}` : "",
      ].filter(Boolean).join("; ")));
    });
  });
}

export function nanoCodexModel(model: string): NanoCodexModel {
  const normalized = model.trim().replace(/^openai\//, "");
  if (normalized === "gpt-5.6-sol" || normalized === "gpt-5.6-terra" || normalized === "gpt-5.6-luna") return normalized;
  throw new Error(
    `NanoCodex supports only openai/gpt-5.6-sol, openai/gpt-5.6-terra, or openai/gpt-5.6-luna; received ${model}.`,
  );
}

/**
 * Maps the application's canonical text session key to NanoCodex's required
 * UUIDv7-shaped identity without creating a second identity registry.
 */
export function nanoCodexSessionId(applicationSessionId: string): string {
  const bytes = createHash("sha256").update(`discord-agent:nanocodex:${applicationSessionId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nanoCodexToolDefinitions(tools: FunctionToolDefinition[]): NanoCodexToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description ?? "",
    strict: false,
    parameters: tool.function.parameters,
  }));
}

function runInput(input: Parameters<typeof runNanoCodexRuntime>[0]): RuntimeInput {
  return {
    type: "run",
    request_id: input.requestId,
    api_key: input.apiKey,
    api_base_url: responsesApiBase(input.apiBaseUrl),
    model: nanoCodexModel(input.model),
    model_id_prefix: "openai",
    thinking: input.thinking,
    reasoning_mode: input.reasoningMode ?? "standard",
    fast_mode: input.fastMode ?? false,
    hosted_web_search: input.hostedWebSearch ?? true,
    workspace_tools: input.workspaceTools ?? false,
    instructions: input.instructions,
    prompt: input.prompt,
    session_id: input.sessionId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    tools: nanoCodexToolDefinitions(input.tools),
  };
}

function responsesApiBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
}

function spawnRuntimeProcess(binary: string, options: { cwd?: string; env?: NodeJS.ProcessEnv }): RuntimeProcess {
  return spawn(binary, [], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

function parseRuntimeOutput(line: string): RuntimeOutput {
  try {
    return JSON.parse(line) as RuntimeOutput;
  } catch (error) {
    throw new Error(
      `NanoCodex runtime emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertRuntimeProtocol(message: RuntimeOutput): void {
  if (message.protocol_version !== NANOCODEX_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`Unsupported NanoCodex runtime protocol version: ${message.protocol_version}`);
  }
}

function assertRequestId(expected: string, actual: string): void {
  if (actual !== expected) throw new Error(`NanoCodex runtime request scope mismatch: expected ${expected}, received ${actual}`);
}

function boundedPush(chunks: string[], chunk: string, limit: number): void {
  chunks.push(chunk);
  let length = chunks.reduce((total, value) => total + value.length, 0);
  while (length > limit && chunks.length > 1) length -= chunks.shift()?.length ?? 0;
  if (chunks.length === 1 && chunks[0].length > limit) chunks[0] = chunks[0].slice(-limit);
}
