import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { logger } from "../util/logger.js";

export const NANOCODE_HOST_PROTOCOL_VERSION = 2;
export const NANOCODE_HOST_BINARY = "discord-agent-nanocodex-runtime";

export type NanocodeThinking = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type NanocodeToolDefinition = {
  type: "function";
  name: string;
  description: string;
  strict: boolean;
  parameters: Record<string, unknown>;
};

export type NanocodeHostEvent = { type: string; [key: string]: unknown };

export type NanocodeToolResult = {
  success: boolean;
  output: string;
  codeModeValue?: unknown;
  metadata?: Record<string, unknown>;
};

export type NanocodeTurnInput = {
  requestId: string;
  sessionId: string;
  model: string;
  thinking: NanocodeThinking;
  instructions: string;
  /** Prepended to the prompt only when the host creates the session. */
  bootstrap?: string;
  prompt: { text: string; images: string[] };
  executeTool: (call: { callId: string; name: string; arguments: unknown }) => Promise<NanocodeToolResult>;
  onEvent?: (event: NanocodeHostEvent) => void | Promise<void>;
  onProgress?: () => void;
  abortSignal?: AbortSignal;
};

export type NanocodeTurnResult = {
  finalMessage: string;
  usage: Record<string, unknown>;
  /** True when the turn continued an existing session. */
  resumed: boolean;
};

/** The host surface the agent runtime depends on; tests supply a fake. */
export type NanocodeHostClient = {
  runTurn(input: NanocodeTurnInput): Promise<NanocodeTurnResult>;
  steer(input: { requestId: string; steerId: string; prompt: { text: string; images: string[] } }): Promise<boolean>;
  activeRequest(sessionId: string): string | undefined;
  stop(): Promise<void>;
};

type HostProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: "exit" | "error", listener: (...args: unknown[]) => void) => unknown;
};

type Outbound =
  | { type: "ready"; protocol_version: number }
  | { type: "configured"; protocol_version: number; durable: boolean }
  | { type: "event"; protocol_version: number; request_id: string; event: NanocodeHostEvent }
  | { type: "tool_call"; protocol_version: number; request_id: string; session_id: string; call_id: string; name: string; arguments: unknown }
  | { type: "steered"; protocol_version: number; request_id: string; steer_id: string; accepted: boolean; error: string | null }
  | { type: "completed"; protocol_version: number; request_id: string; session_id: string; final_message: string; usage: Record<string, unknown>; resumed: boolean }
  | { type: "failed"; protocol_version: number; request_id: string | null; error: string };

type PendingTurn = {
  input: NanocodeTurnInput;
  events: Promise<void>;
  eventFailure?: unknown;
  resolve: (result: NanocodeTurnResult) => void;
  reject: (error: Error) => void;
};

/**
 * Owns the long-lived nanocode host process. One process serves every
 * session: turns, tool calls and steering are multiplexed over its stdio by
 * request, session and call IDs. The process starts on first use and restarts
 * on the next turn after a crash.
 */
export class NanocodeHost implements NanocodeHostClient {
  private process: HostProcess | null = null;
  private starting: Promise<HostProcess> | null = null;
  private readonly turns = new Map<string, PendingTurn>();
  private readonly sessions = new Map<string, string>();
  private readonly steers = new Map<string, (accepted: boolean) => void>();
  private stderr: string[] = [];
  /** Whether the running host keeps sessions in Postgres. */
  durable = false;

  constructor(
    private readonly options: {
      tools: NanocodeToolDefinition[];
      binary?: string;
      env?: NodeJS.ProcessEnv;
      appTitle?: string;
      appUrl?: string;
      apiBaseUrl?: string;
      /** Warn when the host comes up without its durable store. */
      expectDurable?: boolean;
      spawnProcess?: (binary: string, env: NodeJS.ProcessEnv | undefined) => HostProcess;
    },
  ) {}

  activeRequest(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }

  async runTurn(input: NanocodeTurnInput): Promise<NanocodeTurnResult> {
    if (this.turns.has(input.requestId)) throw new Error(`Turn ${input.requestId} is already running`);
    if (this.sessions.has(input.sessionId)) throw new Error(`Session ${input.sessionId} already has a running turn`);
    const process = await this.ensureStarted();
    return await new Promise<NanocodeTurnResult>((resolve, reject) => {
      const pending: PendingTurn = { input, events: Promise.resolve(), resolve, reject };
      const finish = () => {
        this.turns.delete(input.requestId);
        if (this.sessions.get(input.sessionId) === input.requestId) this.sessions.delete(input.sessionId);
        input.abortSignal?.removeEventListener("abort", abort);
      };
      pending.resolve = (result) => { finish(); resolve(result); };
      pending.reject = (error) => { finish(); reject(error); };
      const abort = () => this.write(process, { type: "cancel", request_id: input.requestId });
      if (input.abortSignal?.aborted) {
        reject(new Error("Turn aborted before it started"));
        return;
      }
      input.abortSignal?.addEventListener("abort", abort, { once: true });
      this.turns.set(input.requestId, pending);
      this.sessions.set(input.sessionId, input.requestId);
      this.write(process, {
        type: "turn",
        request_id: input.requestId,
        session_id: input.sessionId,
        model: input.model,
        thinking: input.thinking,
        instructions: input.instructions,
        ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
        prompt: input.prompt,
      });
    });
  }

  async steer(input: { requestId: string; steerId: string; prompt: { text: string; images: string[] } }): Promise<boolean> {
    const process = this.process;
    if (!process || !this.turns.has(input.requestId)) return false;
    const accepted = new Promise<boolean>((resolve) => this.steers.set(`${input.requestId}\0${input.steerId}`, resolve));
    this.write(process, { type: "steer", request_id: input.requestId, steer_id: input.steerId, prompt: input.prompt });
    return await accepted;
  }

  async stop(): Promise<void> {
    const process = this.process;
    if (!process) return;
    const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
    process.stdin.end();
    const killed = setTimeout(() => process.kill("SIGTERM"), 10_000);
    await exited;
    clearTimeout(killed);
  }

  private async ensureStarted(): Promise<HostProcess> {
    if (this.process) return this.process;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return await this.starting;
  }

  private start(): Promise<HostProcess> {
    const binary = this.options.binary ?? NANOCODE_HOST_BINARY;
    const child = (this.options.spawnProcess ?? spawnHostProcess)(binary, this.options.env);
    this.stderr = [];
    child.stderr.on("data", (chunk: Buffer) => boundedPush(this.stderr, chunk.toString("utf8"), 32_000));
    return new Promise<HostProcess>((resolve, reject) => {
      let configured = false;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: Outbound;
        try {
          message = JSON.parse(line) as Outbound;
        } catch {
          return;
        }
        if (message.protocol_version !== NANOCODE_HOST_PROTOCOL_VERSION) {
          reject(new Error(`Unsupported nanocode host protocol version ${message.protocol_version}`));
          child.kill("SIGTERM");
          return;
        }
        if (message.type === "ready") {
          this.write(child, {
            type: "configure",
            tools: this.options.tools,
            ...(this.options.appTitle ? { app_title: this.options.appTitle } : {}),
            ...(this.options.appUrl ? { app_url: this.options.appUrl } : {}),
            ...(this.options.apiBaseUrl ? { api_base_url: this.options.apiBaseUrl } : {}),
          });
          return;
        }
        if (message.type === "configured") {
          configured = true;
          this.durable = message.durable;
          if (!message.durable && this.options.expectDurable) {
            logger.warn({ stderr: this.stderr.join("").slice(-2_000) }, "nanocode host started without its durable session store; sessions will not survive a restart");
          }
          this.process = child;
          resolve(child);
          return;
        }
        if (!configured && message.type === "failed") {
          reject(new Error(`nanocode host failed to start: ${message.error}`));
          return;
        }
        this.handle(child, message);
      });
      const exited = (code: unknown, signal: unknown) => {
        if (this.process === child) this.process = null;
        const diagnostic = this.stderr.join("").trim();
        const error = new Error([
          `nanocode host exited (code=${String(code ?? "none")}, signal=${String(signal ?? "none")})`,
          diagnostic ? `stderr: ${diagnostic.slice(-2_000)}` : "",
        ].filter(Boolean).join("; "));
        if (!configured) reject(error);
        for (const pending of [...this.turns.values()]) pending.reject(error);
        for (const resolveSteer of this.steers.values()) resolveSteer(false);
        this.steers.clear();
      };
      child.once("exit", exited);
      child.once("error", (error) => exited(error instanceof Error ? error.message : "spawn error", null));
    });
  }

  private handle(process: HostProcess, message: Outbound): void {
    switch (message.type) {
      case "event": {
        const pending = this.turns.get(message.request_id);
        if (!pending) return;
        pending.input.onProgress?.();
        // Events keep their order, but a slow ledger write never holds up a
        // tool call or the next protocol line.
        pending.events = pending.events.then(async () => {
          if (pending.eventFailure) return;
          try {
            await pending.input.onEvent?.(message.event);
          } catch (error) {
            pending.eventFailure = error;
          }
        });
        return;
      }
      case "tool_call": {
        const pending = this.turns.get(message.request_id);
        if (!pending) {
          this.write(process, toolResultMessage(message.session_id, message.call_id, {
            success: false,
            output: "The turn that requested this tool is no longer running.",
          }));
          return;
        }
        pending.input.onProgress?.();
        void pending.input
          .executeTool({ callId: message.call_id, name: message.name, arguments: message.arguments })
          .catch((error: unknown): NanocodeToolResult => ({
            success: false,
            output: `Tool ${message.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          }))
          .then((result) => {
            pending.input.onProgress?.();
            this.write(process, toolResultMessage(message.session_id, message.call_id, result));
          });
        return;
      }
      case "steered": {
        const key = `${message.request_id}\0${message.steer_id}`;
        this.steers.get(key)?.(message.accepted);
        this.steers.delete(key);
        return;
      }
      case "completed": {
        const pending = this.turns.get(message.request_id);
        if (!pending) return;
        void pending.events.then(() => {
          if (pending.eventFailure) {
            pending.reject(pending.eventFailure instanceof Error ? pending.eventFailure : new Error(String(pending.eventFailure)));
            return;
          }
          pending.resolve({ finalMessage: message.final_message, usage: message.usage, resumed: message.resumed });
        });
        return;
      }
      case "failed": {
        if (!message.request_id) return;
        const pending = this.turns.get(message.request_id);
        if (!pending) return;
        void pending.events.then(() => pending.reject(new Error(`nanocode turn failed: ${message.error}`)));
        return;
      }
      default:
        return;
    }
  }

  private write(process: HostProcess, message: Record<string, unknown>): void {
    process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function toolResultMessage(sessionId: string, callId: string, result: NanocodeToolResult) {
  return {
    type: "tool_result",
    session_id: sessionId,
    call_id: callId,
    success: result.success,
    output: result.output,
    ...(result.codeModeValue === undefined ? {} : { code_mode_value: result.codeModeValue }),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  };
}

function spawnHostProcess(binary: string, env: NodeJS.ProcessEnv | undefined): HostProcess {
  return spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) }) as unknown as HostProcess;
}

/**
 * nanocode requires UUIDv7-shaped session IDs; this maps the application's
 * session key onto one deterministically.
 */
export function nanocodeSessionId(applicationSessionKey: string): string {
  const bytes = createHash("sha256").update(`discord-agent:nanocode:${applicationSessionKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nanocodeModel(model: string): string {
  const normalized = model.trim().replace(/^openai\//, "");
  if (normalized === "gpt-6-luna" || normalized === "gpt-6-sol") return normalized;
  throw new Error(`nanocode supports only openai/gpt-6-luna or openai/gpt-6-sol; received ${model}.`);
}

function boundedPush(chunks: string[], chunk: string, limit: number): void {
  chunks.push(chunk);
  let length = chunks.reduce((total, value) => total + value.length, 0);
  while (length > limit && chunks.length > 1) length -= chunks.shift()?.length ?? 0;
}
