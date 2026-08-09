import { describe, expect, it } from "vitest";
import { projectConversationTrace } from "../../src/console/conversationTrace.js";

describe("conversation trace projection", () => {
  it("turns raw execution evidence into one readable end-to-end timeline", () => {
    const projection = projectConversationTrace({
      resultCallIds: ["call-1"],
      messages: [
        message("ancestor", "assistant", "Earlier context", "2026-08-09T12:00:00.000Z"),
        message("parent", "assistant", "Deployment update", "2026-08-09T12:04:00.000Z", { directParent: true }),
        message("prompt", "member", "Summarize this update", "2026-08-09T12:05:00.000Z", { current: true, author: "Member" }),
        message("reply", "assistant", "The update is ready.", "2026-08-09T12:05:08.000Z", { reply: true, author: "Assistant" }),
      ],
      traceEvents: [
        event("queued", "agent.execution.queued", "2026-08-09T12:05:00.000Z"),
        event("model-start", "agent.nanocodex.model.call.started", "2026-08-09T12:05:03.000Z", {
          type: "model", metadata: { model: "model-a" }, status: "running",
        }),
        event("tool-start", "agent.tool.started", "2026-08-09T12:05:04.000Z", {
          type: "tool",
          metadata: {
            toolName: "readData",
            callId: "call-1",
            argumentsPreview: '{"source":"production","query":{"limit":25}}',
            argumentsTruncated: false,
          },
          status: "running",
        }),
        event("tool-complete", "agent.tool.complete", "2026-08-09T12:05:05.000Z", {
          type: "tool", metadata: {
            toolName: "readData", callId: "call-1", outputChars: 4821,
            fileCount: 1, tableCount: 2, status: "ok", retryable: false,
          }, durationMs: 1_000,
        }),
        event("model-complete", "agent.nanocodex.model.call.completed", "2026-08-09T12:05:07.000Z", {
          type: "model",
          metadata: { model: "model-a", usage: { total_tokens: 1_234 }, estimatedCostUsd: 0.0123, toolCount: 1 },
          durationMs: 4_000,
        }),
        event("delivery", "discord.delivery.intent_stored", "2026-08-09T12:05:07.000Z", { type: "delivery" }),
        event("success", "agent.execution.succeeded", "2026-08-09T12:05:08.000Z"),
      ],
    });

    expect(projection).toMatchObject({
      startedAt: "2026-08-09T12:05:00.000Z",
      completedAt: "2026-08-09T12:05:08.000Z",
      totalDurationMs: 8_000,
      intakeDurationMs: 3_000,
      agentDurationMs: 4_000,
      deliveryDurationMs: 1_000,
      model: "model-a",
      totalTokens: 1_234,
      estimatedCostUsd: 0.0123,
      toolCount: 1,
      contextCount: 2,
      rawEventCount: 7,
    });
    expect(projection.phases.map((phase) => phase.id)).toEqual([
      "context", "prompt", "intake", "agent", "response", "delivery",
    ]);
    expect(projection.phases.find((phase) => phase.id === "context")).toMatchObject({
      summary: "Deployment update",
      metadata: { contextCount: 2, olderContextCount: 1 },
      contextMessages: [{ id: "ancestor", content: "Earlier context" }],
    });
    expect(projection.phases.find((phase) => phase.id === "agent")).toMatchObject({
      startedAt: "2026-08-09T12:05:03.000Z",
      completedAt: "2026-08-09T12:05:07.000Z",
      durationMs: 4_000,
      metadata: { model: "model-a", totalTokens: 1_234, estimatedCostUsd: 0.0123, toolCount: 1 },
      tools: [{
        callId: "call-1",
        title: "readData",
        durationMs: 1_000,
        arguments: { source: "production", query: { limit: 25 } },
        argumentsTruncated: false,
        resultAvailable: true,
        outputChars: 4821,
        fileCount: 1,
        tableCount: 2,
        retryable: false,
        sourceEventIds: ["tool-start", "tool-complete"],
      }],
    });
    expect(projection.phases.find((phase) => phase.id === "response")?.startedAt).toBe("2026-08-09T12:05:07.000Z");
  });

  it("keeps failures visible in their owning phase without exposing unrelated metadata", () => {
    const projection = projectConversationTrace({
      messages: [message("prompt", "member", "Check the latest data", "2026-08-09T12:00:00.000Z", { current: true })],
      traceEvents: [
        event("model-start", "agent.nanocodex.model.call.started", "2026-08-09T12:00:01.000Z", { type: "model" }),
        event("model-failed", "agent.nanocodex.model.call.failed", "2026-08-09T12:00:02.000Z", {
          type: "model", level: "error", status: "failed", title: "Model call failed", summary: "Provider request failed.",
        }),
      ],
    });

    expect(projection.phases.find((phase) => phase.id === "agent")).toMatchObject({
      status: "failed",
      exceptions: [{
        id: "model-failed",
        title: "Model call failed",
        summary: "Provider request failed.",
        code: "agent.nanocodex.model.call.failed",
      }],
    });
    expect(JSON.stringify(projection)).not.toContain("argumentsPreview");
  });

  it("counts executed tools separately from deduplicated attempts", () => {
    const projection = projectConversationTrace({
      messages: [message("prompt", "member", "Generate it", "2026-08-09T12:00:00.000Z", { current: true })],
      traceEvents: [
        event("tool-complete", "agent.tool.complete", "2026-08-09T12:00:01.000Z", {
          type: "tool", metadata: { toolName: "generateImage", status: "ok" },
        }),
        event("tool-reused", "agent.tool.complete", "2026-08-09T12:00:02.000Z", {
          type: "tool", metadata: { toolName: "generateImage", status: "reused" },
        }),
        event("complete", "agent.nanocodex.complete", "2026-08-09T12:00:03.000Z", {
          metadata: { toolCalls: 1, toolAttempts: 2, reusedToolCalls: 1 },
        }),
      ],
    });

    expect(projection).toMatchObject({ toolCount: 1, reusedToolCount: 1 });
    expect(projection.phases.find((phase) => phase.id === "agent")).toMatchObject({
      summary: "Completed with 1 tool call; 1 duplicate call reused.",
      metadata: { toolCount: 1, reusedToolCount: 1 },
      tools: [{ title: "generateImage" }],
    });
  });

  it("derives legacy tool totals from executions rather than nested provider metadata", () => {
    const projection = projectConversationTrace({
      messages: [message("prompt", "member", "Check this", "2026-08-09T12:00:00.000Z", { current: true })],
      traceEvents: [
        event("tool-a", "agent.tool.complete", "2026-08-09T12:00:01.000Z", {
          type: "tool", metadata: { toolName: "inspectDiscordImages", status: "ok" },
        }),
        event("tool-b", "agent.tool.complete", "2026-08-09T12:00:02.000Z", {
          type: "tool", metadata: { toolName: "inspectDiscordImages", status: "ok" },
        }),
        event("provider", "agent.model.call.completed", "2026-08-09T12:00:03.000Z", {
          type: "model", metadata: { toolCount: 1 },
        }),
      ],
    });

    expect(projection.toolCount).toBe(2);
    expect(projection.phases.find((phase) => phase.id === "agent")?.tools).toHaveLength(2);
  });
});

function message(
  id: string,
  role: string,
  content: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) {
  return { id, role, content, createdAt, ...extra };
}

function event(
  id: string,
  code: string,
  occurredAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    code,
    occurredAt,
    type: "event",
    title: code,
    summary: "",
    level: "info",
    status: "done",
    metadata: {},
    durationMs: null,
    ...extra,
  };
}
