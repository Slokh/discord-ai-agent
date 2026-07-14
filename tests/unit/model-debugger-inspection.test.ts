import { describe, expect, it } from "vitest";
import { formatModelDebuggerInspection, formatModelIoCaptures } from "../../src/observability/modelDebuggerInspection.js";
import type { RunSnapshot } from "../../src/observability/runs.js";

describe("model debugger run inspection", () => {
  it("summarizes model rounds, prompt composition, tools, cache use, and critical-path gaps", () => {
    const snapshot = {
      run: { durationMs: 10_000 },
      events: [{
        id: "model-1",
        name: "agent.model.call.completed",
        durationMs: 6_500,
        metadata: {
          callId: "call-1",
          purpose: "tool_selection",
          model: "test/model",
          promptBytes: 30_000,
          toolSchemaBytes: 5_000,
          usage: { inputTokens: 8_000, outputTokens: 120, cachedInputTokens: 4_000 },
          estimatedCostUsd: 0.0042,
          requestedToolCalls: ["searchDiscordHistory"],
          promptSections: [
            { name: "base_system_prompt", bytes: 20_000, estimatedTokens: 5_000 },
            { name: "current_user_request", bytes: 200, estimatedTokens: 50 },
          ],
        },
      }],
      agentTranscript: [{ role: "tool", metadata: { durationMs: 1_000 } }],
      artifacts: [
        { kind: "model_prompt" },
        { kind: "model_response" },
      ],
    } as unknown as RunSnapshot;

    const output = formatModelDebuggerInspection(snapshot);

    expect(output).toContain("no private chain-of-thought");
    expect(output).toContain("wall=10.00s model=6.50s tool=1.00s uninstrumented=2.50s cache=50% cost=$0.004200");
    expect(output).toContain("model-bound");
    expect(output).toContain("Tool Selection: test/model");
    expect(output).toContain("Base System Prompt=5,000t/19.5KB");
    expect(output).toContain("requested=searchDiscordHistory");
    expect(output).toContain("prompts=1 responses=1");
  });

  it("degrades cleanly for runs created before model-call telemetry", () => {
    const snapshot = { run: { durationMs: 100 }, events: [], agentTranscript: [], artifacts: [] } as unknown as RunSnapshot;
    expect(formatModelDebuggerInspection(snapshot)).toContain("no observed model-call telemetry");
  });

  it("redacts secrets and bounds exact model input/output excerpts", () => {
    const secret = `sk-or-v1-${"a".repeat(30)}`;
    const output = formatModelIoCaptures([
      { kind: "model_prompt", name: "Prompt", content: `${secret}\n${"context ".repeat(400)}` },
      { kind: "model_response", name: "Response", content: null },
    ]);

    expect(output).toContain("Model input · Prompt");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(secret);
    expect(output).toContain("...[truncated]");
    expect(output).toContain("Capture expired or unavailable");
  });
});
