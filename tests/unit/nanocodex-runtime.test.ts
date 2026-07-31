import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  nanoCodexModel,
  nanoCodexSessionId,
  nanoCodexToolDefinitions,
  runNanoCodexRuntime,
} from "../../src/agent/nanocodexRuntime.js";

class FakeRuntimeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly received: unknown[] = [];

  constructor() {
    super();
    let buffered = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        this.received.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
    });
  }

  send(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

describe("NanoCodex native runtime protocol", () => {
  it("accepts every model supported by the owned NanoCodex fork", () => {
    expect(nanoCodexModel("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(nanoCodexModel("openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(nanoCodexModel("openai/gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("runs one scoped turn and returns tool results to NanoCodex", async () => {
    const child = new FakeRuntimeProcess();
    const executeTool = vi.fn(async () => ({ success: true, output: "verified result" }));
    const onEvent = vi.fn();
    const resultPromise = runNanoCodexRuntime({
      apiKey: "secret-key",
      apiBaseUrl: "https://openrouter.ai/api/v1/",
      model: "openai/gpt-5.6-sol",
      thinking: "high",
      instructions: "Keep scope exact.",
      prompt: "Do the thing.",
      requestId: "request-1",
      sessionId: "018f1f9a-7b3c-7a01-8000-000000000001",
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Look up verified data.",
          parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }],
      executeTool,
      onEvent,
      spawnProcess: () => child as never,
    });

    child.send({ type: "ready", protocol_version: 1 });
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    expect(child.received[0]).toMatchObject({
      type: "run",
      request_id: "request-1",
      api_key: "secret-key",
      api_base_url: "https://openrouter.ai/api/v1",
      model: "gpt-5.6-sol",
      model_id_prefix: "openai",
      hosted_web_search: true,
      workspace_tools: false,
      tools: [{ type: "function", name: "lookup" }],
    });

    child.send({
      type: "event",
      protocol_version: 1,
      request_id: "request-1",
      event: { protocol_version: 1, request_id: "request-1", seq: 1, type: "run.started", payload: {} },
    });
    child.send({
      type: "tool_call",
      protocol_version: 1,
      request_id: "request-1",
      session_id: "session-1",
      call_id: "call-1",
      name: "lookup",
      arguments: { id: "abc" },
    });
    await vi.waitFor(() => expect(child.received).toHaveLength(2));
    expect(executeTool).toHaveBeenCalledWith({ callId: "call-1", name: "lookup", arguments: { id: "abc" } });
    expect(child.received[1]).toEqual({
      type: "tool_result",
      call_id: "call-1",
      success: true,
      output: "verified result",
    });

    const snapshot = {
      version: 1,
      model: "gpt-5.6-sol",
      lineage_id: "lineage",
      prompt_cache_key: "cache",
      workspace: "/workspace",
      canonical_context: {},
      history: [],
    };
    child.send({
      type: "completed",
      protocol_version: 1,
      request_id: "request-1",
      final_message: "done",
      usage: { total_tokens: 12 },
      snapshot,
    });

    await expect(resultPromise).resolves.toEqual({
      finalMessage: "done",
      usage: { total_tokens: 12 },
      snapshot,
    });
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("fails closed on request-scope mismatch", async () => {
    const child = new FakeRuntimeProcess();
    const result = runNanoCodexRuntime({
      apiKey: "secret-key",
      apiBaseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.6-luna",
      thinking: "low",
      instructions: "test",
      prompt: "test",
      requestId: "expected",
      sessionId: "018f1f9a-7b3c-7a01-8000-000000000001",
      tools: [],
      executeTool: async () => ({ success: true, output: "unused" }),
      spawnProcess: () => child as never,
    });
    child.send({ type: "ready", protocol_version: 1 });
    child.send({
      type: "completed",
      protocol_version: 1,
      request_id: "other",
      final_message: "wrong",
      usage: {},
      snapshot: {},
    });
    await expect(result).rejects.toThrow(/request scope mismatch/);
  });

  it("accepts only NanoCodex models and converts tool schemas", () => {
    expect(nanoCodexModel("openai/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(() => nanoCodexModel("z-ai/glm-5.2")).toThrow(/supports only/);
    expect(nanoCodexToolDefinitions([{
      type: "function",
      function: { name: "ping", description: "Ping.", parameters: { type: "object" } },
    }])).toEqual([{
      type: "function",
      name: "ping",
      description: "Ping.",
      strict: false,
      parameters: { type: "object" },
    }]);
  });

  it("maps canonical application session keys to stable UUIDv7 identities", () => {
    const first = nanoCodexSessionId("agent-session-example");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(nanoCodexSessionId("agent-session-example")).toBe(first);
    expect(nanoCodexSessionId("agent-session-other")).not.toBe(first);
  });
});
