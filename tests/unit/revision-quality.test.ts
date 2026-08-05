import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import {
  assessRevisionQuality,
  collectRevisionQualityObservation,
  findBaselineQualityCohort,
  findRevisionQualityCohort,
  revisionQualityClusterAbsenceStatuses,
  revisionQualityDetectionInputs,
  type RevisionQuality,
  type RevisionQualityPrivateFailureCluster,
} from "../../src/observability/revisionQuality.js";

describe("collectRevisionQuality", () => {
  it("returns content-free aggregates and reads delivery state", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ model: "test/model", status: "succeeded", count: 2, p95_ms: 50 }] })
      .mockResolvedValueOnce({ rows: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ level: "warn", count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ state: "delivered", count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        kind: "runtime_event", category: "model", event_name: "agent.model.call.failed",
        error_kind: "openrouter_timeout_error", error_code: null, error_status: null,
        tool_name: null, status: null, execution_id: "private-execution-a",
      }] })
      .mockResolvedValueOnce({ rows: [{ revision: "revision-1" }] });
    const pool = { query } as unknown as DbPool;

    const observation = await collectRevisionQualityObservation(pool, "revision-1", 48);
    const result = observation.quality;

    expect(result).toMatchObject({
      revision: "revision-1",
      qualityVersion: null,
      contributingRevisions: ["revision-1"],
      windowHours: 48,
      answers: [{ model: "test/model", status: "succeeded", count: 2, p95_ms: 50 }],
      tools: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }],
      signals: [{ level: "warn", count: 1 }],
      deliveries: [{ state: "delivered", count: 2 }],
      improvements: [],
      failureClusters: [expect.objectContaining({
        kind: "runtime_event",
        category: "model",
        eventName: "agent.model.call.failed",
        errorKind: "openrouter_timeout_error",
        count: 1,
      })],
    });
    expect(JSON.stringify(result)).not.toContain("private-execution-a");
    expect(observation.failureClusters[0]?.executionIds).toEqual(["private-execution-a"]);
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls[3]?.[0]).toContain("obligation.state");
    expect(query.mock.calls[3]?.[0]).toContain("interval '5 minutes'");
    expect(query.mock.calls.slice(0, 4).every((call) => call[0].includes("qualityCohort"))).toBe(true);
    expect(query.mock.calls.every((call) => call[1]?.[0] === 48 && call[1]?.[1] === "revision-1")).toBe(true);
    expect(query.mock.calls[4]?.[0]).toContain("signal.source IN");
  });

  it("coalesces statistical evidence by behavior identity but keeps hard evidence revision-scoped", async () => {
    const cohort = {
      qualityVersion: "quality-a",
      promptVersion: "prompt-a",
      toolVersion: "tool-a",
      configVersion: "config-a",
      qualityRuntimeVersion: "1",
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ model: "test/model", status: "succeeded", count: 12 }] })
      .mockResolvedValueOnce({ rows: [{ tool: "web__run", status: "ok", count: 6 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: "revision-0" }, { revision: "revision-1" }] });

    const result = await collectRevisionQualityObservation({ query } as unknown as DbPool, "revision-1", 48, cohort);

    expect(result.quality).toMatchObject({
      qualityVersion: "quality-a",
      contributingRevisions: ["revision-0", "revision-1"],
    });
    for (const index of [0, 1, 6]) {
      expect(query.mock.calls[index]?.[0]).toContain("promptVersion");
      expect(query.mock.calls[index]?.[1]).toEqual([48, "prompt-a", "tool-a", "config-a", "1"]);
    }
    expect(query.mock.calls[4]?.[0]).toContain("signal.execution_id IS NOT NULL");
    expect(query.mock.calls[4]?.[1]).toEqual([48, "prompt-a", "tool-a", "config-a", "1", "revision-1"]);
    for (const index of [2, 3, 5]) {
      expect(query.mock.calls[index]?.[0]).toContain("appRevision");
      expect(query.mock.calls[index]?.[1]).toEqual([48, "revision-1"]);
    }
  });

  it("resolves exact and prior behavior identities from retained runtime metadata", async () => {
    const row = {
      revision: "revision-0",
      prompt_version: "prompt-a",
      tool_version: "tool-a",
      config_version: "config-a",
      quality_runtime_version: "1",
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const pool = { query } as unknown as DbPool;
    await expect(findRevisionQualityCohort(pool, "revision-1")).resolves.toMatchObject({ promptVersion: "prompt-a" });
    const current = {
      qualityVersion: "current",
      promptVersion: "prompt-b",
      toolVersion: "tool-b",
      configVersion: "config-b",
      qualityRuntimeVersion: "1",
    };
    await expect(findBaselineQualityCohort(pool, current, 48)).resolves.toMatchObject({
      revision: "revision-0",
      cohort: { promptVersion: "prompt-a" },
    });
    expect(query.mock.calls[1]?.[1]).toEqual([48, "prompt-b", "tool-b", "config-b", "1"]);
  });
});

describe("assessRevisionQuality", () => {
  it("waits for a useful answer sample when no hard failure exists", () => {
    expect(assessRevisionQuality(quality({ succeeded: 2 })).status).toBe("insufficient_data");
  });

  it("distinguishes a new revision that has not received member traffic", () => {
    expect(assessRevisionQuality(quality({ succeeded: 0 }, { tools: [] }))).toMatchObject({
      status: "awaiting_traffic",
      recommendation: "observe",
      sample: { minimumAnswers: 10, minimumToolCalls: 5, answersRemaining: 10, toolCallsRemaining: 5 },
    });
  });

  it("fails on durable delivery and error evidence even with a small sample", () => {
    const assessment = assessRevisionQuality(quality({ succeeded: 2 }, {
      signals: [{ level: "error", count: 1 }],
      deliveries: [{ state: "pending", count: 1 }, { state: "abandoned", count: 1 }],
      failureClusters: [failureCluster("runtime_event", { count: 1 })],
    }));
    expect(assessment.status).toBe("fail");
    expect(assessment.violations).toEqual(expect.arrayContaining([
      "1 overdue deliveries exceed 0",
      "1 abandoned deliveries exceed 0",
      "1 error signals exceed 0",
    ]));
  });

  it("marks a regression against a healthy baseline as a rollback candidate", () => {
    const baseline = quality({ succeeded: 20 }, { p95Ms: 1_000 });
    const current = quality({ succeeded: 12, failed: 8 }, { p95Ms: 2_000 });
    const assessment = assessRevisionQuality(current, baseline);
    expect(assessment.status).toBe("fail");
    expect(assessment.recommendation).toBe("rollback_candidate");
    expect(assessment.comparisons).toEqual(expect.arrayContaining([
      expect.stringContaining("answer failure rate increased"),
      expect.stringContaining("answer p95 is 2.00x"),
    ]));
  });

  it("treats improvement signals as an answer incident rate", () => {
    const assessment = assessRevisionQuality(quality({ succeeded: 10 }, {
      improvements: [{ source: "member_report", classification: "defect", count: 3 }],
    }));
    expect(assessment.status).toBe("fail");
    expect(assessment.violations).toContain("improvement signals per answer 30.0% exceeds 20.0%");
  });

  it("separates recovered validation retries from terminal capability failures", () => {
    const assessment = assessRevisionQuality(quality({ succeeded: 10 }, {
      tools: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }],
    }));
    expect(assessment.metrics).toMatchObject({ toolCalls: 1, toolAttempts: 4, toolRetries: 3, recoveredValidationRetries: 3, toolFailures: 0 });
    expect(assessment.violations).not.toEqual(expect.arrayContaining([expect.stringContaining("tool failure rate")]));
  });

  it("creates exact execution-linked detections with root-cause identity", () => {
    const failedQuality = quality({ succeeded: 2 }, {
      signals: [{ level: "error", count: 1 }],
      failureClusters: [failureCluster("runtime_event", {
        reference: "revision-quality:runtime_event:timeout",
        category: "model",
        eventName: "agent.model.call.failed",
        errorKind: "openrouter_timeout_error",
        count: 2,
      })],
    });
    const failed = assessRevisionQuality(failedQuality);
    const privateClusters: RevisionQualityPrivateFailureCluster[] = [{
      ...failedQuality.failureClusters[0]!,
      executionIds: ["execution-a", "execution-b"],
    }];
    const detections = revisionQualityDetectionInputs(failedQuality, failed, privateClusters);
    expect(detections).toHaveLength(2);
    expect(detections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "runtime_detection",
        stableCode: "revision-quality:runtime_event:timeout",
        executionId: "execution-a",
        appRevision: "test-revision",
        owningDomain: "models",
        metadata: expect.objectContaining({
          assessmentStatus: "fail",
          failureEventName: "agent.model.call.failed",
          failureErrorKind: "openrouter_timeout_error",
          occurrenceCount: 2,
        }),
      }),
    ]));
    expect(new Set(detections.map((detection) => detection.sourceId)).size).toBe(2);

    const waitingQuality = quality({ succeeded: 0 }, { tools: [] });
    expect(revisionQualityDetectionInputs(waitingQuality, assessRevisionQuality(waitingQuality), [])).toEqual([]);
  });

  it("creates a medium-severity defect for a slow successful capability without failing the release gate", () => {
    const current = quality({ succeeded: 10 }, {
      failureClusters: [failureCluster("tool_latency", {
        reference: "revision-quality:tool_latency:1234567890abcdef12345678",
        category: "tool",
        toolName: "getRecentDiscordMessages",
        status: "budget_exceeded",
        latencyBudgetMs: 15_000,
        maxDurationMs: 46_000,
      })],
    });
    const assessment = assessRevisionQuality(current);
    const detections = revisionQualityDetectionInputs(current, assessment, [{
      ...current.failureClusters[0]!,
      executionIds: ["execution-slow"],
    }]);

    expect(assessment.status).toBe("pass");
    expect(detections).toEqual([expect.objectContaining({
      classification: "defect",
      severity: "medium",
      owningDomain: "retrieval",
      executionId: "execution-slow",
      metadata: expect.objectContaining({ latencyBudgetMs: 15_000, maxDurationMs: 46_000 }),
    })]);
  });

  it("requires enough successful calls of the same tool before proving a slow-success cluster absent", () => {
    const insufficient = revisionQualityClusterAbsenceStatuses(quality({ succeeded: 10 }, {
      tools: [
        { tool: "getRecentDiscordMessages", status: "ok", count: 2 },
        { tool: "getDiscordStats", status: "ok", count: 20 },
      ],
    }));
    const sufficient = revisionQualityClusterAbsenceStatuses(quality({ succeeded: 10 }, {
      tools: [{ tool: "getRecentDiscordMessages", status: "ok", count: 3 }],
    }));

    expect(Object.keys(insufficient)).toHaveLength(1);
    expect(Object.keys(sufficient)).toHaveLength(1);
    expect(Object.keys(insufficient)[0]).not.toBe(Object.keys(sufficient)[0]);
    expect(Object.values(sufficient)).toEqual(["passed"]);
  });
});

function quality(
  statuses: Record<string, number>,
  overrides: { p95Ms?: number; tools?: Record<string, unknown>[]; signals?: Record<string, unknown>[]; deliveries?: Record<string, unknown>[]; improvements?: Record<string, unknown>[]; failureClusters?: RevisionQuality["failureClusters"] } = {},
): RevisionQuality {
  return {
    revision: "test-revision",
    qualityVersion: null,
    qualityCohort: null,
    contributingRevisions: ["test-revision"],
    windowHours: 48,
    generatedAt: new Date(0).toISOString(),
    answers: Object.entries(statuses).map(([status, count]) => ({ model: "test/model", status, count, p95_ms: overrides.p95Ms ?? 100 })),
    tools: overrides.tools ?? [{ tool: "web__run", status: "ok", count: 10 }],
    signals: overrides.signals ?? [],
    deliveries: overrides.deliveries ?? [{ state: "delivered", count: 1 }],
    improvements: overrides.improvements ?? [],
    failureClusters: overrides.failureClusters ?? [],
  };
}

function failureCluster(kind: RevisionQuality["failureClusters"][number]["kind"], overrides: Partial<RevisionQuality["failureClusters"][number]> = {}) {
  return {
    reference: `revision-quality:${kind}:test`,
    kind,
    category: null,
    eventName: null,
    errorKind: null,
    errorCode: null,
    errorStatus: null,
    toolName: null,
    status: null,
    latencyBudgetMs: null,
    maxDurationMs: null,
    count: 1,
    ...overrides,
  };
}
