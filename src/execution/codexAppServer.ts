import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CodexAppServerNotification = {
  method: string;
  params?: JsonValue;
  raw: JsonObject;
};

export type CodexTurnResult = {
  threadId: string;
  turnId: string;
  notifications: CodexAppServerNotification[];
  retries: number;
  terminalMethod: "turn/completed" | "turn/failed" | "error";
};

export type CodexAppServerOptions = {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  maxEngineRetries?: number;
  retryDelayMs?: (retry: number) => number;
};

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
};

type TurnGuardResult =
  | { type: "forward"; values: CodexAppServerNotification[] }
  | { type: "done"; values: CodexAppServerNotification[]; terminalMethod: CodexTurnResult["terminalMethod"] }
  | { type: "retry"; withheld: CodexAppServerNotification[] };
type TerminalTurnGuardResult = Exclude<TurnGuardResult, { type: "forward" }>;

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationQueue: CodexAppServerNotification[] = [];
  private readonly notificationWaiters: Array<{
    resolve: (notification: CodexAppServerNotification) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly stderrChunks: string[] = [];
  private requestId = 1;
  private closed = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly options: Required<Pick<CodexAppServerOptions, "maxEngineRetries" | "retryDelayMs">> &
      Omit<CodexAppServerOptions, "maxEngineRetries" | "retryDelayMs">
  ) {
    this.child = child;
    this.startReaders();
  }

  static spawn(options: CodexAppServerOptions): CodexAppServerClient {
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server", "--listen", "stdio://"];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return new CodexAppServerClient(child, {
      ...options,
      maxEngineRetries: options.maxEngineRetries ?? 2,
      retryDelayMs: options.retryDelayMs ?? codexEngineRetryDelayMs
    });
  }

  async initialize(input: { clientName?: string; version?: string } = {}): Promise<JsonObject> {
    return this.request("initialize", {
      clientInfo: {
        name: input.clientName ?? "discord-ai-agent-codegen",
        title: null,
        version: input.version ?? "0.1.0"
      },
      capabilities: null
    });
  }

  async startThread(input: { cwd?: string; provider?: string } = {}): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: input.cwd ?? this.options.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      modelProvider: input.provider ?? this.options.provider ?? providerForModel(this.options.model)
    });
    const threadId = stringAt(result, ["thread", "id"]);
    if (!threadId) throw new Error("Codex app-server thread/start response missing thread.id.");
    return threadId;
  }

  async resumeThread(input: { threadId: string; cwd?: string; provider?: string }): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId: input.threadId,
      cwd: input.cwd ?? this.options.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      modelProvider: input.provider ?? this.options.provider ?? providerForModel(this.options.model),
      excludeTurns: false
    });
    const threadId = stringAt(result, ["thread", "id"]) ?? input.threadId;
    if (!threadId) throw new Error("Codex app-server thread/resume response missing thread.id.");
    return threadId;
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    model?: string;
    reasoningEffort?: string;
    onNotification?: (notification: CodexAppServerNotification) => Promise<void> | void;
  }): Promise<CodexTurnResult> {
    const params = this.turnParams(input);
    const notifications: CodexAppServerNotification[] = [];
    let retries = 0;
    while (true) {
      const turnStart = await this.request("turn/start", params);
      const turnId = stringAt(turnStart, ["turn", "id"]);
      if (!turnId) throw new Error("Codex app-server turn/start response missing turn.id.");
      const terminal = await this.readTurnNotifications(input.threadId, turnId, input.onNotification);
      if (terminal.type === "retry" && retries < this.options.maxEngineRetries) {
        retries += 1;
        await sleep(this.options.retryDelayMs(retries));
        continue;
      }
      if (terminal.type === "retry") {
        notifications.push(...terminal.withheld);
        return {
          threadId: input.threadId,
          turnId,
          notifications,
          retries,
          terminalMethod: "error"
        };
      }
      notifications.push(...terminal.values);
      return {
        threadId: input.threadId,
        turnId,
        notifications,
        retries,
        terminalMethod: terminal.terminalMethod
      };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGTERM");
    await Promise.race([once(this.child, "close"), sleep(2_000)]).catch(() => undefined);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  stderrTail(maxChars = 12_000): string {
    const text = this.stderrChunks.join("");
    return text.length <= maxChars ? text : text.slice(text.length - maxChars);
  }

  private turnParams(input: { threadId: string; text: string; model?: string; reasoningEffort?: string }) {
    const params: JsonObject = {
      threadId: input.threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }]
    };
    const model = input.model ?? this.options.model;
    if (model) params.model = model;
    const effort = input.reasoningEffort ?? this.options.reasoningEffort;
    if (effort) params.effort = effort;
    return params;
  }

  private async request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed) throw new Error("Codex app-server client is closed.");
    const id = this.requestId++;
    const payload = JSON.stringify({ id, method, params });
    const responsePromise = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${payload}\n`);
    return responsePromise;
  }

  private startReaders() {
    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleStdoutLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString("utf8"));
      if (this.stderrChunks.length > 200) this.stderrChunks.splice(0, this.stderrChunks.length - 200);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`Codex app-server exited before completing pending requests (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    });
  }

  private handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: JsonObject;
    try {
      const parsed = JSON.parse(trimmed) as JsonValue;
      if (!isJsonObject(parsed)) return;
      value = parsed;
    } catch {
      return;
    }

    const id = typeof value.id === "number" ? value.id : null;
    if (id != null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = isJsonObject(value.error) ? value.error : null;
      if (error) {
        pending.reject(new Error(`Codex app-server request ${id} failed: ${JSON.stringify(error)}`));
        return;
      }
      const result = isJsonObject(value.result) ? value.result : {};
      pending.resolve(result);
      return;
    }

    const method = typeof value.method === "string" ? value.method : null;
    if (!method) return;
    this.enqueueNotification({ method, params: value.params, raw: value });
  }

  private enqueueNotification(notification: CodexAppServerNotification) {
    const waiter = this.notificationWaiters.shift();
    if (waiter) {
      waiter.resolve(notification);
      return;
    }
    this.notificationQueue.push(notification);
  }

  private async nextNotification(): Promise<CodexAppServerNotification> {
    const queued = this.notificationQueue.shift();
    if (queued) return queued;
    return new Promise<CodexAppServerNotification>((resolve, reject) => {
      this.notificationWaiters.push({ resolve, reject });
    });
  }

  private async readTurnNotifications(
    threadId: string,
    turnId: string,
    onNotification?: (notification: CodexAppServerNotification) => Promise<void> | void
  ): Promise<TerminalTurnGuardResult> {
    const guard = new TurnGuard();
    const forwarded: CodexAppServerNotification[] = [];
    while (true) {
      const notification = await this.nextNotification();
      const result = guard.observe(notification, isTerminalNotification(notification, threadId, turnId));
      if (result.type === "forward") {
        await emitNotifications(result.values, onNotification);
        forwarded.push(...result.values);
        continue;
      }
      if (result.type === "done") {
        await emitNotifications(result.values, onNotification);
        return { ...result, values: [...forwarded, ...result.values] };
      }
      if (result.type === "retry") {
        return { ...result, withheld: [...forwarded, ...result.withheld] };
      }
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.notificationWaiters) waiter.reject(error);
    this.notificationWaiters.splice(0, this.notificationWaiters.length);
  }
}

async function emitNotifications(
  notifications: CodexAppServerNotification[],
  onNotification?: (notification: CodexAppServerNotification) => Promise<void> | void
) {
  if (!onNotification) return;
  for (const notification of notifications) {
    await onNotification(notification);
  }
}

class TurnGuard {
  private pendingSystemError: CodexAppServerNotification | null = null;
  private streamed = false;

  observe(notification: CodexAppServerNotification, terminal: boolean): TurnGuardResult {
    if (terminal && notification.method === "error" && !this.streamed && isRetriableEngineError(notification)) {
      const withheld = [this.pendingSystemError, notification].filter((value): value is CodexAppServerNotification => Boolean(value));
      this.pendingSystemError = null;
      return { type: "retry", withheld };
    }

    const values: CodexAppServerNotification[] = [];
    if (this.pendingSystemError) {
      values.push(this.pendingSystemError);
      this.pendingSystemError = null;
    }

    if (!this.streamed && isSystemErrorStatus(notification)) {
      this.pendingSystemError = notification;
      return { type: "forward", values };
    }

    if (streamsTurnOutput(notification.method)) this.streamed = true;
    values.push(notification);

    if (terminal) {
      return { type: "done", values, terminalMethod: terminalMethod(notification) };
    }
    return { type: "forward", values };
  }
}

export function providerForModel(model?: string | null): string {
  return model?.includes("/") ? "openrouter" : "openai";
}

export function isRetriableEngineError(notification: CodexAppServerNotification): boolean {
  const message = stringAt(notification.raw, ["params", "error", "message"]) ?? "";
  return message.includes("Engine not found") || (message.includes("Job registration failed") && message.includes("404"));
}

function isSystemErrorStatus(notification: CodexAppServerNotification) {
  return notification.method === "thread/status/changed" && stringAt(notification.raw, ["params", "status", "type"]) === "systemError";
}

function streamsTurnOutput(method: string) {
  return method.startsWith("item/") || method === "thread/tokenUsage/updated";
}

function isTerminalNotification(notification: CodexAppServerNotification, threadId: string, turnId: string) {
  if (notification.method === "error") return true;
  if (notification.method !== "turn/completed" && notification.method !== "turn/failed") return false;
  const notificationThreadId = stringAt(notification.raw, ["params", "threadId"]) ?? threadId;
  const notificationTurnId = stringAt(notification.raw, ["params", "turn", "id"]) ?? stringAt(notification.raw, ["params", "turnId"]) ?? turnId;
  return notificationThreadId === threadId && notificationTurnId === turnId;
}

function terminalMethod(notification: CodexAppServerNotification): CodexTurnResult["terminalMethod"] {
  if (notification.method === "turn/completed" || notification.method === "turn/failed" || notification.method === "error") {
    return notification.method;
  }
  return "error";
}

function stringAt(value: JsonValue | undefined, path: string[]): string | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function codexEngineRetryDelayMs(retry: number) {
  const shift = Math.max(0, Math.min(4, retry - 1));
  return Math.min(500 * 2 ** shift, 5_000);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
