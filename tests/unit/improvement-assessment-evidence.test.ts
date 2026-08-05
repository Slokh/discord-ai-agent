import { describe, expect, it, vi } from "vitest";
import {
  IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
  renderPrivateAssessmentEvidence,
} from "../../src/improvements/assessmentEvidence.js";

describe("improvement assessment evidence", () => {
  it("hydrates the linked execution and channel-scoped archived source context", async () => {
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
    const archive = {
      messageContext: vi.fn(async () => ([
        archivedMessage("message-before", "Earlier synthetic context"),
        archivedMessage("message-a", "Reported synthetic prompt"),
        archivedMessage("message-after", "Synthetic reply context"),
      ])),
    };

    const rendered = await renderPrivateAssessmentEvidence("case-a", [signal(executionId)], runtime as never, archive, {
      case: { status: "actionable", classification: "defect", severity: "high", owningDomain: "runtime" },
      acceptedContract: {
        contractId: "contract-a",
        version: 2,
        expectedBehavior: "The runtime check passes.",
        checks: [{ kind: "runtime_event", name: "runtime.check.passed", expectation: "required" }],
        sourceRevision: "revision-a",
      },
    });
    const evidence = JSON.parse(rendered);

    expect(evidence.schemaVersion).toBe(IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION);
    expect(evidence.acceptedContract).toEqual(expect.objectContaining({ contractId: "contract-a", version: 2 }));
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
    expect(archive.messageContext).toHaveBeenCalledWith({
      guildId: "guild-a",
      visibleChannelIds: ["channel-a"],
      messageId: "message-a",
      before: 2,
      after: 2,
    });
    expect(evidence.reportedMessageContexts).toEqual([expect.objectContaining({
      signalIds: ["signal-a"],
      sourceMessageId: "message-a",
      missing: false,
      messages: expect.arrayContaining([
        expect.objectContaining({ messageId: "message-a", content: "Reported synthetic prompt", reported: true }),
        expect.objectContaining({ messageId: "message-after", content: "Synthetic reply context", reported: false }),
      ]),
    })]);
  });

  it("hydrates archived context when a report has no linked execution", async () => {
    const runtime = {
      getExecution: vi.fn(),
      listMessagesForExecution: vi.fn(),
      listEvents: vi.fn(),
      getArtifact: vi.fn(),
    };
    const archive = {
      messageContext: vi.fn(async () => ([archivedMessage("message-a", "Reported standalone interaction")])),
    };

    const rendered = await renderPrivateAssessmentEvidence("case-archive", [signal(null)], runtime as never, archive);
    const evidence = JSON.parse(rendered);

    expect(evidence.runs).toEqual([]);
    expect(evidence.reportedMessageContexts[0]).toEqual(expect.objectContaining({
      sourceMessageId: "message-a",
      missing: false,
      messages: [expect.objectContaining({ content: "Reported standalone interaction", reported: true })],
    }));
    expect(runtime.getExecution).not.toHaveBeenCalled();
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

    const rendered = await renderPrivateAssessmentEvidence(
      "case-large",
      [signal(executionId)],
      runtime as never,
      { messageContext: vi.fn(async () => []) },
    );

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

function signal(executionId: string | null) {
  return {
    signalId: "signal-a",
    source: "member_report",
    summary: "Synthetic report summary",
    details: null,
    executionId,
    messageId: "message-a",
    guildId: "guild-a",
    channelId: "channel-a",
    appRevision: "revision-a",
  };
}

function archivedMessage(messageId: string, content: string) {
  return {
    messageId,
    guildId: "guild-a",
    channelId: "channel-a",
    authorId: "author-a",
    authorUsername: "synthetic-user",
    content,
    normalizedContent: content.toLowerCase(),
    createdAt: new Date("2026-08-05T12:00:00.000Z"),
    score: 1,
    link: `https://discord.invalid/${messageId}`,
  };
}
