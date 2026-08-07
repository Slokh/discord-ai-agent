import { describe, expect, it } from "vitest";
import { deriveOperatorAttention } from "../../src/console/attention.js";

describe("operator console attention", () => {
  it("combines unhealthy services, stalled executions, blocked improvements, and failed producers", () => {
    const now = new Date("2026-08-06T12:20:00.000Z");
    const attention = deriveOperatorAttention({
      services: [
        { component: "bot", status: "healthy" },
        { component: "worker", status: "degraded", source: "kubernetes" },
      ],
      executions: [{
        executionId: "execution-a",
        title: "Answer a member",
        updatedAt: "2026-08-06T12:00:00.000Z",
        latestEvent: "agent.execution.started",
      }],
      improvements: { cases: [{
        caseId: "case-a",
        title: "Repair delivery",
        severity: "high",
        automationState: "blocked",
        blocker: "reporter_response_pending",
        pullRequestUrl: "https://github.com/owner/repo/pull/1",
      }] },
      producers: [{ trigger: "production_observation", status: "failed", outcomeCode: "probe_failed" }],
    }, { now, stalledExecutionMs: 10 * 60_000 });

    expect(attention.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "execution", "improvement", "producer", "service",
    ]));
    expect(attention.find((item) => item.kind === "improvement")).toMatchObject({
      detail: "reporter response pending",
      link: "https://github.com/owner/repo/pull/1",
    });
  });

  it("does not turn unavailable telemetry or healthy automation into an alert", () => {
    expect(deriveOperatorAttention({
      services: [{ component: "console", status: "unavailable" }],
      executions: [],
      improvements: { cases: [{ caseId: "case-a", severity: "high", automationState: "waiting" }] },
      producers: [{ trigger: "release_promotion", status: "succeeded" }],
    })).toEqual([]);
  });
});
