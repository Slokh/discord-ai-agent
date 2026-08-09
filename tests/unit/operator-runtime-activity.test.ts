import { describe, expect, it } from "vitest";
import { dashboardTraceEvent } from "../../src/db/operatorRuntimeActivityRepository.js";

describe("operator runtime activity", () => {
  it("exposes readable tool arguments while redacting credential material", () => {
    const event = dashboardTraceEvent({
      id: 2,
      sequence: 8,
      kind: "tool",
      level: "info",
      event_name: "agent.tool.started",
      summary: "inspectDiscordImages",
      metadata: {
        toolName: "inspectDiscordImages",
        callId: "call-1",
        argumentsPreview: JSON.stringify({
          messageIdOrUrl: "https://discord.com/channels/1/2/3",
          imageUrl: "https://example.com/image.png?x-amz-signature=private-signature",
          apiKey: "ordinary-looking-private-value",
          question: "What is shown?",
        }),
        argumentsTruncated: false,
      },
      duration_ms: null,
      span_id: null,
      parent_span_id: null,
      created_at: new Date("2026-08-09T00:00:00Z"),
    });

    expect(event.metadata).toMatchObject({
      toolName: "inspectDiscordImages",
      callId: "call-1",
      argumentsTruncated: false,
    });
    expect(JSON.parse(String(event.metadata.argumentsPreview))).toEqual({
      messageIdOrUrl: "https://discord.com/channels/1/2/3",
      imageUrl: "https://example.com/image.png?x-amz-signature=[REDACTED]",
      apiKey: "[REDACTED]",
      question: "What is shown?",
    });
  });

  it("shows the retained sandbox diagnosis without exposing raw pod logs", () => {
    const event = dashboardTraceEvent({
      id: 1,
      sequence: 7,
      kind: "lifecycle",
      level: "error",
      event_name: "agent.task.completed",
      summary: "Job has reached the specified backoff limit",
      metadata: {
        status: "failed",
        failureCode: "sandbox_oom",
        diagnosticsStatus: "available",
        failureDiagnosis: { summary: "The coding workspace ran out of memory during implementation." },
        observed: { diagnosticLog: "private output" },
      },
      duration_ms: null,
      span_id: null,
      parent_span_id: null,
      created_at: new Date("2026-08-09T00:00:00Z"),
    });

    expect(event.summary).toContain("ran out of memory");
    expect(event.metadata).toMatchObject({ failureCode: "sandbox_oom", diagnosticsStatus: "available" });
    expect(JSON.stringify(event)).not.toContain("private output");
    expect(JSON.stringify(event)).not.toContain("backoff limit");
  });
});
