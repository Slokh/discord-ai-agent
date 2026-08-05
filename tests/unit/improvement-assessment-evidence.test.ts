import { describe, expect, it, vi } from "vitest";
import {
  IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
  renderPrivateAssessmentEvidence,
} from "../../src/improvements/assessmentEvidence.js";

describe("improvement assessment evidence", () => {
  it("hydrates only the linked execution transcript and its retained artifacts", async () => {
    const executionId = "execution-current";
    const sessionId = "shared-channel-session";
    const runtime = {
      getExecution: vi.fn(async () => ({
        executionId,
        sessionId,
        taskId: null,
        traceId: "trace-current",
        attempt: 1,
        status: "succeeded",
        harness: "agent",
        model: "test-model",
        provider: "test-provider",
        reasoningEffort: "low",
        sandboxId: null,
        sandboxRunId: null,
        branchName: null,
        prUrl: null,
        draft: null,
        verifyPassed: null,
        error: null,
        metadata: { request: "current synthetic request" },
        createdAt: new Date("2026-08-05T12:00:00.000Z"),
        startedAt: new Date("2026-08-05T12:00:00.000Z"),
        completedAt: new Date("2026-08-05T12:00:01.000Z"),
        updatedAt: new Date("2026-08-05T12:00:01.000Z"),
      })),
      listMessagesForExecution: vi.fn(async () => ([
        runtimeMessage("user", "current synthetic request", executionId),
        runtimeMessage("tool", "synthetic tool result", executionId),
        runtimeMessage("assistant", "current synthetic reply", executionId),
      ])),
      listEvents: vi.fn(async () => ([{
        id: 1,
        sessionId,
        executionId,
        traceId: "trace-current",
        sequence: 1,
        kind: "model",
        level: "info",
        eventName: "agent.model.call.completed",
        summary: "answer",
        metadata: {
          promptArtifactId: "artifact-prompt",
          responseArtifactId: "artifact-response",
          deliveryIntentArtifactId: "artifact-delivery",
        },
        durationMs: 100,
        createdAt: new Date("2026-08-05T12:00:01.000Z"),
      }])),
      getArtifact: vi.fn(async ({ artifactId }: { artifactId: string }) => ({
        artifactId,
        sessionId,
        executionId,
        kind: artifactId === "artifact-prompt"
          ? "model_prompt"
          : artifactId === "artifact-response"
            ? "model_response"
            : "discord_delivery_intent",
        name: artifactId,
        contentType: "application/json",
        sizeBytes: 20,
        preview: "synthetic",
        redacted: true,
        expiresAt: null,
        metadata: {},
        createdAt: new Date("2026-08-05T12:00:01.000Z"),
        content: JSON.stringify({ value: artifactId }),
      })),
    };

    const rendered = await renderPrivateAssessmentEvidence("case-a", [signal(executionId)], runtime as never);
    const evidence = JSON.parse(rendered);

    expect(evidence.schemaVersion).toBe(IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION);
    expect(evidence.runs[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        parts: expect.arrayContaining([expect.objectContaining({ text: "current synthetic request" })]),
      }),
      expect.objectContaining({
        role: "assistant",
        parts: expect.arrayContaining([expect.objectContaining({ text: "current synthetic reply" })]),
      }),
    ]));
    expect(evidence.runs[0].artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual([
      "model_prompt",
      "model_response",
      "discord_delivery_intent",
    ]);
    expect(runtime.listMessagesForExecution).toHaveBeenCalledWith({ sessionId, executionId, limit: 100 });
    expect(runtime.getArtifact).toHaveBeenCalledTimes(3);
  });

  it("keeps oversized evidence bounded and parseable while preserving both ends", async () => {
    const executionId = "execution-large";
    const largeText = `beginning-${"x".repeat(130_000)}-ending`;
    const runtime = {
      getExecution: vi.fn(async () => ({
        executionId,
        sessionId: "session-large",
        metadata: {},
      })),
      listMessagesForExecution: vi.fn(async () => ([runtimeMessage("assistant", largeText, executionId)])),
      listEvents: vi.fn(async () => []),
      getArtifact: vi.fn(),
    };

    const rendered = await renderPrivateAssessmentEvidence("case-large", [signal(executionId)], runtime as never);

    expect(rendered.length).toBeLessThanOrEqual(100_000);
    expect(() => JSON.parse(rendered)).not.toThrow();
    expect(rendered).toContain("beginning-");
    expect(rendered).toContain("-ending");
  });
});

function runtimeMessage(role: "user" | "assistant" | "tool", text: string, executionId: string) {
  return {
    messageId: `${role}-message`,
    sessionId: "shared-channel-session",
    clientMessageId: null,
    role,
    parts: [{ type: "text", text }],
    metadata: { executionId },
    createdAt: new Date("2026-08-05T12:00:00.000Z"),
  };
}

function signal(executionId: string) {
  return {
    signalId: "signal-a",
    source: "member_report",
    summary: "Synthetic report summary",
    details: null,
    executionId,
    messageId: "message-a",
    appRevision: "revision-a",
  };
}
