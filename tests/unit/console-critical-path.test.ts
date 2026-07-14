import { describe, expect, it } from "vitest";
import { criticalPathFromSnapshot } from "../../src/control/console/criticalPath.js";
import type { RunSnapshot } from "../../src/control/console/types.js";

describe("console critical-path analysis", () => {
  it("attributes model, tool, and otherwise uninstrumented wall time", () => {
    const snapshot = {
      generatedAt: "2026-07-13T00:00:10.000Z",
      run: { startedAt: "2026-07-13T00:00:00.000Z", completedAt: "2026-07-13T00:00:10.000Z", durationMs: 10_000 },
      events: [modelEvent({ durationMs: 6_500, inputTokens: 30_000, cachedInputTokens: 1_000 })],
      agentTranscript: [{
        id: "tool-1",
        role: "tool",
        parts: ["result"],
        metadata: { toolName: "searchDiscordHistory", durationMs: 1_000, round: 1, outputChars: 800 },
      }],
    } as unknown as RunSnapshot;

    const result = criticalPathFromSnapshot(snapshot);

    expect(result).toMatchObject({
      durationMs: 10_000,
      modelDurationMs: 6_500,
      toolDurationMs: 1_000,
      unattributedDurationMs: 2_500,
    });
    expect(result.items.map((item) => item.category)).toEqual(["model", "other", "tool"]);
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining("Model-bound"),
      expect.stringContaining("low cache reuse"),
    ]));
  });

  it("uses transcript tool durations instead of counting generic tool events", () => {
    const snapshot = {
      generatedAt: "2026-07-13T00:00:01.000Z",
      run: { startedAt: "2026-07-13T00:00:00.000Z", durationMs: 1_000 },
      events: [{ category: "tool", durationMs: 900, name: "agent.tool.called" }],
      agentTranscript: [],
    } as unknown as RunSnapshot;

    expect(criticalPathFromSnapshot(snapshot).toolDurationMs).toBe(0);
  });
});

function modelEvent(input: { durationMs: number; inputTokens: number; cachedInputTokens: number }) {
  return {
    id: "model-1",
    source: "runtime",
    level: "info",
    category: "model",
    name: "agent.model.call.completed",
    summary: "final_synthesis",
    createdAt: "2026-07-13T00:00:00.000Z",
    durationMs: input.durationMs,
    metadata: {
      callId: "call-1",
      purpose: "final_synthesis",
      model: "test/model",
      promptBytes: 30_000,
      usage: { inputTokens: input.inputTokens, cachedInputTokens: input.cachedInputTokens },
    },
  };
}
