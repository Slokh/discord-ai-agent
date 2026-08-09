import { describe, expect, it } from "vitest";
import { dashboardTraceEvent } from "../../src/db/operatorRuntimeActivityRepository.js";

describe("operator runtime activity", () => {
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
