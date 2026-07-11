import { describe, expect, it, vi } from "vitest";
import { runObservedModelCall } from "../../src/agent/modelCallTelemetry.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(chat: ToolContext["openRouter"]["chat"]): ToolContext {
  return {
    config: { appRevision: "test-revision" } as never,
    repo: {
      recordTraceEvent: vi.fn(async () => undefined),
      recordProcessRunSpan: vi.fn(async () => undefined),
      auditTool: vi.fn(async () => undefined),
    },
    openRouter: { chat },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: [],
    requestId: "trace-1",
  } as unknown as ToolContext;
}

describe("runObservedModelCall", () => {
  it("records complete prompt, usage, cost, and latency telemetry", async () => {
    const ctx = context(vi.fn(async () => ({
      content: "done",
      model: "test/model",
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, cachedInputTokens: 10 },
      estimatedCostUsd: 0.001,
      toolCalls: [],
      raw: {},
    })));

    await runObservedModelCall(ctx, {
      purpose: "final_synthesis",
      chat: { messages: [{ role: "user", content: "hello" }], tools: [], maxTokens: 100 },
    });

    expect(ctx.repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.model.call.completed",
      metadata: expect.objectContaining({
        schemaVersion: 1,
        appRevision: "test-revision",
        purpose: "final_synthesis",
        model: "test/model",
        promptBytes: expect.any(Number),
        toolSchemaBytes: 2,
        usage: expect.objectContaining({ inputTokens: 20, cachedInputTokens: 10 }),
        estimatedCostUsd: 0.001,
      }),
    }));
  });

  it("records failed calls and rethrows the provider error", async () => {
    const ctx = context(vi.fn(async () => { throw new Error("provider down"); }));

    await expect(runObservedModelCall(ctx, {
      purpose: "tool_selection",
      chat: { messages: [{ role: "user", content: "hello" }] },
    })).rejects.toThrow("provider down");

    expect(ctx.repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.model.call.failed",
      level: "error",
      metadata: expect.objectContaining({ error: "provider down" }),
    }));
  });
});
