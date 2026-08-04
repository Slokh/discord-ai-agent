import { describe, expect, it, vi } from "vitest";
import { recordAgentEvent } from "../../src/agent/runtimeTranscript.js";
import type { ToolContext } from "../../src/tools/types.js";

function ctx(repo: Record<string, unknown>, requestId?: string): ToolContext {
  return {
    repo,
    requestId,
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
  } as unknown as ToolContext;
}

describe("runtime transcript event recorder", () => {
  it("records trace and audit sinks without creating a process-run span", async () => {
    const repo = {
      recordTraceEvent: vi.fn(async () => undefined),
      auditTool: vi.fn(async () => undefined),
    };

    await recordAgentEvent(ctx(repo, "run-1"), {
      eventName: "agent.model.round.complete",
      level: "info",
      summary: "round complete",
      metadata: { round: 1 },
      durationMs: 25,
      span: {
        spanId: "agent.model.round.1",
        name: "LLM round 1",
        status: "succeeded",
        startedAt: new Date("2026-07-09T00:00:00.000Z"),
        completedAt: new Date("2026-07-09T00:00:00.025Z"),
        durationMs: 25,
        metadata: { model: "test-model" },
      },
      audit: {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        toolName: "chat",
        argumentsSummary: "hello",
        resultSummary: "hi",
        model: "test-model",
        estimatedCostUsd: 0.001,
      },
    });

    expect(repo.recordTraceEvent).toHaveBeenCalledWith({
      eventName: "agent.model.round.complete",
      level: "info",
      summary: "round complete",
      metadata: { round: 1 },
      durationMs: 25,
      traceId: undefined,
      requestId: undefined,
      guildId: undefined,
      channelId: undefined,
      userId: undefined,
      messageId: undefined,
    });
    expect(repo.auditTool).toHaveBeenCalledWith({
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      toolName: "chat",
      argumentsSummary: "hello",
      resultSummary: "hi",
      model: "test-model",
      estimatedCostUsd: 0.001,
    });
  });

  it("gracefully no-ops when optional repo sinks are absent", async () => {
    await expect(
      recordAgentEvent(ctx({}, "run-1"), {
        eventName: "agent.request.started",
        summary: "hello",
        span: { spanId: "span", name: "Span" },
        audit: { toolName: "chat" },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not require a process-run fallback for span input", async () => {
    await expect(recordAgentEvent(ctx({}), {
      span: {
        spanId: "agent.model.round.1",
        name: "LLM round 1",
        status: "running",
      },
    })).resolves.toBeUndefined();
  });
});
