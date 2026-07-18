import { describe, expect, it, vi } from "vitest";
import { promptSectionTelemetry, runObservedModelCall } from "../../src/agent/modelCallTelemetry.js";
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
      serverToolUse: { web_search_requests: 1, tool_calls_executed: 1 },
      urlCitations: [{ url: "https://example.com/result", title: "Result" }],
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
        serverToolUse: { web_search_requests: 1, tool_calls_executed: 1 },
        urlCitationCount: 1,
        requestedToolCalls: ["openrouter:web_search"],
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

  it("stores redacted debugger artifacts for the exact model prompt and response", async () => {
    const ctx = context(vi.fn(async () => ({
      content: "final answer",
      model: "test/model",
      finishReason: "tool_calls",
      usage: { inputTokens: 30, outputTokens: 6 },
      serverToolUse: { web_search_requests: 1 },
      urlCitations: [{ url: "https://example.com/result", title: "Result" }],
      estimatedCostUsd: 0.002,
      toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: "{\"query\":\"hello\"}" }],
      raw: {},
    })));
    const storeArtifact = vi.fn(async (input: { kind: string }) => ({ artifactId: `${input.kind}-artifact` }));
    const recordEvent = vi.fn(async () => undefined);
    ctx.agentRuntime = { storeArtifact, recordEvent } as never;
    ctx.agentRuntimeSession = { sessionId: "session-1", traceId: "trace-1" } as never;
    ctx.agentRuntimeExecutionId = "execution-1";

    await runObservedModelCall(ctx, {
      purpose: "tool_selection",
      chat: {
        messages: [
          { role: "system", content: "base instructions" },
          { role: "system", content: "Loaded skills:\nNo skills loaded." },
          { role: "user", content: "hello" },
        ],
        tools: [{ type: "function", function: { name: "searchDiscordHistory", parameters: { type: "object" } } }],
      },
    });

    expect(storeArtifact).toHaveBeenCalledTimes(2);
    expect(storeArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "model_prompt", contentType: "application/json" }));
    expect(storeArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "model_response",
      content: expect.stringMatching(/"serverToolUse"[\s\S]*"web_search_requests": 1[\s\S]*"urlCitations"/),
    }));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.model.call.completed",
      metadata: expect.objectContaining({
        promptArtifactId: "model_prompt-artifact",
        responseArtifactId: "model_response-artifact",
        serverToolUse: { web_search_requests: 1 },
        urlCitationCount: 1,
        requestedToolCalls: ["searchDiscordHistory", "openrouter:web_search"],
        promptSections: expect.arrayContaining([expect.objectContaining({ name: "base_system_prompt" })]),
        toolSchemas: [expect.objectContaining({ name: "searchDiscordHistory", type: "local" })],
      }),
    }));
  });

  it("attributes prompt bytes to stable debugger sections", () => {
    expect(promptSectionTelemetry([
      { role: "system", content: "base" },
      { role: "system", content: "Current Discord requester: User" },
      { role: "system", content: "Loaded skills:\nNo skills loaded." },
      { role: "system", content: "The current user message is a Discord reply. parent" },
      { role: "user", content: "latest" },
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "base_system_prompt", messageCount: 1 }),
      expect.objectContaining({ name: "requester_identity", messageCount: 1 }),
      expect.objectContaining({ name: "loaded_skills", messageCount: 1 }),
      expect.objectContaining({ name: "reply_chain", messageCount: 1 }),
      expect.objectContaining({ name: "current_user_request", messageCount: 1 }),
    ]));
  });
});
