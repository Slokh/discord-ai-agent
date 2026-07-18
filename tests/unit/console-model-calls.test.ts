import { describe, expect, it } from "vitest";
import { modelCallsFromSnapshot } from "../../src/control/console/modelCalls.js";
import type { RunSnapshot } from "../../src/control/console/types.js";

describe("console model-call projection", () => {
  it("projects versioned model telemetry into a complete call view", () => {
    const snapshot = {
      events: [{
        id: "event-1",
        source: "runtime",
        level: "info",
        name: "agent.model.call.completed",
        summary: "final_synthesis",
        createdAt: "2026-07-10T00:00:00.000Z",
        durationMs: 1234,
        metadata: {
          purpose: "final_synthesis",
          appRevision: "abc123",
          model: "test/model",
          promptBytes: 1000,
          promptSections: [{ name: "base_system_prompt", bytes: 600, characters: 550, messageCount: 1, estimatedTokens: 138, roles: ["system"] }],
          toolSchemaBytes: 2,
          toolSchemas: [{ name: "searchDiscordHistory", type: "local", bytes: 2 }],
          toolCount: 0,
          promptArtifactId: "prompt-1",
          responseArtifactId: "response-1",
          outputChars: 42,
          finishReason: "stop",
          estimatedCostUsd: 0.002,
          serverToolUse: { web_search_requests: 2, tool_calls_executed: 2 },
          urlCitationCount: 7,
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
        },
      }],
    } as unknown as Pick<RunSnapshot, "events">;

    expect(modelCallsFromSnapshot(snapshot)).toEqual([
      expect.objectContaining({
        id: "event-1",
        purpose: "final_synthesis",
        appRevision: "abc123",
        model: "test/model",
        durationMs: 1234,
        promptBytes: 1000,
        promptSections: [expect.objectContaining({ name: "base_system_prompt", estimatedTokens: 138 })],
        toolSchemas: [expect.objectContaining({ name: "searchDiscordHistory", bytes: 2 })],
        promptArtifactId: "prompt-1",
        responseArtifactId: "response-1",
        costUsd: 0.002,
        serverToolUse: { web_search_requests: 2, tool_calls_executed: 2 },
        urlCitationCount: 7,
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 }),
      }),
    ]);
  });

  it("falls back to legacy round events", () => {
    const snapshot = {
      events: [{
        id: "legacy",
        source: "runtime",
        level: "info",
        name: "agent.model.round.complete",
        summary: "Round 2",
        createdAt: "2026-07-10T00:00:00.000Z",
        durationMs: 500,
        metadata: { round: 2, model: "legacy/model", usage: { totalTokens: 20 } },
      }],
    } as unknown as Pick<RunSnapshot, "events">;

    expect(modelCallsFromSnapshot(snapshot)[0]).toEqual(expect.objectContaining({
      purpose: "tool_selection_round_2",
      model: "legacy/model",
    }));
  });
});
