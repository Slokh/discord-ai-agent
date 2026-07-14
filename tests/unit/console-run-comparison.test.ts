import { describe, expect, it } from "vitest";
import { comparisonFacts, purposeComparisonRows } from "../../src/control/console/runComparison.js";
import type { RunSnapshot } from "../../src/control/console/types.js";

describe("console run comparison", () => {
  it("compares wall time, model time, prompt size, cache usage, and cost", () => {
    const snapshot = runSnapshot([modelEvent("route", 500, 1_000, 400, 5_000, 0.001)], 2_000);

    expect(comparisonFacts(snapshot)).toEqual(expect.objectContaining({
      durationMs: 2_000,
      modelCalls: 1,
      modelDurationMs: 500,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      promptBytes: 5_000,
      cost: 0.001,
    }));
  });

  it("aligns model rounds by purpose even when one side has no matching call", () => {
    const current = runSnapshot([modelEvent("route", 500, 100, 0, 1_000, 0.001), modelEvent("synthesis", 800, 200, 0, 2_000, 0.002)], 1_500);
    const baseline = runSnapshot([modelEvent("route", 250, 50, 0, 500, 0.0005)], 800);

    expect(purposeComparisonRows(current, baseline)).toEqual([
      expect.objectContaining({ purpose: "route", current: expect.objectContaining({ calls: 1, durationMs: 500 }), baseline: expect.objectContaining({ calls: 1, durationMs: 250 }) }),
      expect.objectContaining({ purpose: "synthesis", current: expect.objectContaining({ calls: 1 }), baseline: expect.objectContaining({ calls: 0 }) }),
    ]);
  });
});

function runSnapshot(events: unknown[], durationMs: number) {
  return {
    generatedAt: "2026-07-13T00:00:02.000Z",
    run: { runId: "run-1", startedAt: "2026-07-13T00:00:00.000Z", completedAt: "2026-07-13T00:00:02.000Z", durationMs },
    events,
    agentTranscript: [],
  } as unknown as RunSnapshot;
}

function modelEvent(purpose: string, durationMs: number, inputTokens: number, cachedInputTokens: number, promptBytes: number, cost: number) {
  return {
    id: `${purpose}-${durationMs}`,
    source: "runtime",
    level: "info",
    category: "model",
    name: "agent.model.call.completed",
    summary: purpose,
    createdAt: "2026-07-13T00:00:00.000Z",
    durationMs,
    metadata: {
      callId: `${purpose}-${durationMs}`,
      purpose,
      model: "test/model",
      promptBytes,
      estimatedCostUsd: cost,
      usage: { inputTokens, cachedInputTokens },
    },
  };
}
