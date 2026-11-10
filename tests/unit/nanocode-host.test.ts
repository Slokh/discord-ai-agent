import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { NANOCODE_HOST_PROTOCOL_VERSION, NanocodeHost, nanocodeModel, nanocodeSessionId } from "../../src/agent/nanocodeHost.js";

const V = NANOCODE_HOST_PROTOCOL_VERSION;

/** A scripted stand-in for the host binary: it records what the client writes and answers on stdout. */
function fakeProcess(options: { durable?: boolean; onMessage?: (message: any, fake: ReturnType<typeof fakeProcess>) => void } = {}) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: any[] = [];
  let buffer = "";
  const fake = {
    written,
    stdout,
    stderr,
    send: (message: Record<string, unknown>) => stdout.write(`${JSON.stringify({ protocol_version: V, ...message })}\n`),
    exit: (code: number) => emitter.emit("exit", code, null),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const message = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          written.push(message);
          if (message.type === "configure") fake.send({ type: "configured", durable: options.durable ?? true });
          options.onMessage?.(message, fake);
          index = buffer.indexOf("\n");
        }
        callback();
      },
      final(callback) {
        setImmediate(() => emitter.emit("exit", 0, null));
        callback();
      },
    }),
    kill: vi.fn(() => true),
    once: (event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener),
  };
  setImmediate(() => fake.send({ type: "ready" }));
  return fake;
}

const turnInput = (overrides: Record<string, unknown> = {}) => ({
  requestId: "req-1",
  sessionId: "session-1",
  model: "gpt-6-luna",
  thinking: "high" as const,
  instructions: "instructions",
  prompt: { text: "hello", images: [] },
  executeTool: vi.fn(async () => ({ success: true, output: "ok" })),
  ...overrides,
});

describe("NanocodeHost client", () => {
  it("configures the host once, then runs a turn with ordered events and concurrent tool calls", async () => {
    let fake!: ReturnType<typeof fakeProcess>;
    const host = new NanocodeHost({
      tools: [{ type: "function", name: "add", description: "Add", strict: false, parameters: {} }],
      apiBaseUrl: "http://127.0.0.1:1/api/v1",
      appTitle: "Test",
      spawnProcess: () => {
        fake = fakeProcess({
          onMessage: (message, process) => {
            if (message.type === "turn") {
              process.send({ type: "event", request_id: "req-1", event: { type: "run.started" } });
              process.send({ type: "tool_call", request_id: "req-1", session_id: "session-1", call_id: "c1", name: "add", arguments: { a: 1 } });
              process.send({ type: "tool_call", request_id: "req-1", session_id: "session-1", call_id: "c2", name: "add", arguments: { a: 2 } });
            }
            if (message.type === "tool_result" && process.written.filter((m) => m.type === "tool_result").length === 2) {
              process.send({ type: "event", request_id: "req-1", event: { type: "run.completed" } });
              process.send({ type: "completed", request_id: "req-1", session_id: "session-1", final_message: "done", usage: { total_tokens: 3 }, resumed: true });
            }
          },
        });
        return fake as never;
      },
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const events: string[] = [];
    const result = await host.runTurn(turnInput({
      bootstrap: "earlier",
      onEvent: async (event: { type: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(event.type);
      },
      executeTool: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { success: true, output: "ok", codeModeValue: { n: 1 }, metadata: { status: "ok" } };
      }),
    }));

    expect(result).toEqual({ finalMessage: "done", usage: { total_tokens: 3 }, resumed: true });
    expect(maxInFlight).toBe(2);
    expect(events).toEqual(["run.started", "run.completed"]);
    expect(host.durable).toBe(true);
    expect(fake.written[0]).toMatchObject({ type: "configure", api_base_url: "http://127.0.0.1:1/api/v1", app_title: "Test" });
    expect(fake.written.find((m) => m.type === "turn")).toMatchObject({ bootstrap: "earlier", request_id: "req-1" });
    expect(fake.written.filter((m) => m.type === "tool_result")[0]).toMatchObject({ success: true, code_mode_value: { n: 1 }, metadata: { status: "ok" } });
    expect(host.activeRequest("session-1")).toBeUndefined();
    await host.stop();
  });

  it("reports tool failures to the host and fails the turn when the host does", async () => {
    let fake!: ReturnType<typeof fakeProcess>;
    const host = new NanocodeHost({
      tools: [],
      spawnProcess: () => {
        fake = fakeProcess({
          onMessage: (message, process) => {
            if (message.type === "turn") process.send({ type: "tool_call", request_id: "req-1", session_id: "session-1", call_id: "c1", name: "boom", arguments: {} });
            if (message.type === "tool_result") process.send({ type: "failed", request_id: "req-1", error: "provider unavailable" });
          },
        });
        return fake as never;
      },
    });
    await expect(host.runTurn(turnInput({ executeTool: vi.fn(async () => { throw new Error("tool exploded"); }) })))
      .rejects.toThrow("nanocode turn failed: provider unavailable");
    expect(fake.written.find((m) => m.type === "tool_result")).toMatchObject({ success: false, output: "Tool boom failed: tool exploded" });
    await host.stop();
  });

  it("answers a tool call for a turn it is not running with an error instead of hanging the host", async () => {
    let fake!: ReturnType<typeof fakeProcess>;
    const host = new NanocodeHost({
      tools: [],
      spawnProcess: () => {
        fake = fakeProcess({
          onMessage: (message, process) => {
            if (message.type === "turn") {
              process.send({ type: "completed", request_id: "req-1", session_id: "session-1", final_message: "ok", usage: {}, resumed: false });
              process.send({ type: "tool_call", request_id: "req-unknown", session_id: "session-9", call_id: "late", name: "add", arguments: {} });
            }
          },
        });
        return fake as never;
      },
    });
    await host.runTurn(turnInput());
    await vi.waitFor(() => expect(fake.written.find((m) => m.call_id === "late")).toMatchObject({ success: false }));
    await host.stop();
  });

  it("steers a running turn, cancels on abort, and refuses a second turn in the same session", async () => {
    let fake!: ReturnType<typeof fakeProcess>;
    const host = new NanocodeHost({
      tools: [],
      spawnProcess: () => {
        fake = fakeProcess({
          onMessage: (message, process) => {
            if (message.type === "steer") process.send({ type: "steered", request_id: message.request_id, steer_id: message.steer_id, accepted: true, error: null });
            if (message.type === "cancel") process.send({ type: "failed", request_id: message.request_id, error: "cancelled" });
          },
        });
        return fake as never;
      },
    });
    const controller = new AbortController();
    const running = host.runTurn(turnInput({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(host.activeRequest("session-1")).toBe("req-1"));
    await expect(host.runTurn(turnInput({ requestId: "req-2" }))).rejects.toThrow("already has a running turn");
    await expect(host.steer({ requestId: "req-1", steerId: "s-1", prompt: { text: "also", images: [] } })).resolves.toBe(true);
    await expect(host.steer({ requestId: "missing", steerId: "s-2", prompt: { text: "x", images: [] } })).resolves.toBe(false);
    controller.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(fake.written.map((m) => m.type)).toEqual(expect.arrayContaining(["steer", "cancel"]));
    await host.stop();
  });

  it("fails in-flight turns when the host exits, then starts a new host for the next turn", async () => {
    const spawned: Array<ReturnType<typeof fakeProcess>> = [];
    const host = new NanocodeHost({
      tools: [],
      spawnProcess: () => {
        const fake = fakeProcess({
          durable: false,
          onMessage: (message, process) => {
            if (message.type !== "turn") return;
            if (spawned.length === 1) {
              process.stderr.write("panic: something broke\n");
              setImmediate(() => process.exit(101));
            } else {
              process.send({ type: "completed", request_id: message.request_id, session_id: message.session_id, final_message: "recovered", usage: {}, resumed: false });
            }
          },
        });
        spawned.push(fake);
        return fake as never;
      },
    });
    await expect(host.runTurn(turnInput())).rejects.toThrow(/nanocode host exited \(code=101.*stderr: panic: something broke/);
    await expect(host.runTurn(turnInput({ requestId: "req-2" }))).resolves.toMatchObject({ finalMessage: "recovered" });
    expect(spawned).toHaveLength(2);
    expect(host.durable).toBe(false);
    await host.stop();
  });

  it("rejects a host speaking another protocol version", async () => {
    const host = new NanocodeHost({
      tools: [],
      spawnProcess: () => {
        const stdout = new PassThrough();
        const emitter = new EventEmitter();
        setImmediate(() => stdout.write(`${JSON.stringify({ type: "ready", protocol_version: V + 1 })}\n`));
        return {
          stdin: new PassThrough(),
          stdout,
          stderr: new PassThrough(),
          kill: vi.fn(() => { emitter.emit("exit", null, "SIGTERM"); return true; }),
          once: (event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener),
        } as never;
      },
    });
    await expect(host.runTurn(turnInput())).rejects.toThrow("Unsupported nanocode host protocol version");
  });
});

describe("nanocode identifiers", () => {
  it("maps application session keys to stable UUIDv7-shaped IDs", () => {
    const id = nanocodeSessionId("discord:g:c:user:abc");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(nanocodeSessionId("discord:g:c:user:abc")).toBe(id);
    expect(nanocodeSessionId("discord:g:c:other:abc")).not.toBe(id);
  });

  it("accepts only the models nanocode serves", () => {
    expect(nanocodeModel("openai/gpt-6-luna")).toBe("gpt-6-luna");
    expect(nanocodeModel(" gpt-6-sol ")).toBe("gpt-6-sol");
    expect(() => nanocodeModel("anthropic/claude")).toThrow("nanocode supports only");
  });
});
