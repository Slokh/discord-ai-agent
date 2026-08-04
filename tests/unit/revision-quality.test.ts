import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import {
  assessRevisionQuality,
  collectRevisionQuality,
  findBaselineRevision,
  type RevisionQuality,
} from "../../src/observability/revisionQuality.js";

describe("collectRevisionQuality", () => {
  it("returns content-free aggregates and reads delivery state", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ model: "test/model", status: "succeeded", count: 2, p95_ms: 50 }] })
      .mockResolvedValueOnce({ rows: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ level: "warn", count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ state: "delivered", count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ rating: "good", failure_mode: "unclassified", count: 1 }] });
    const pool = { query } as unknown as DbPool;

    const result = await collectRevisionQuality(pool, "revision-1", 48);

    expect(result).toMatchObject({
      revision: "revision-1",
      windowHours: 48,
      answers: [{ model: "test/model", status: "succeeded", count: 2, p95_ms: 50 }],
      tools: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }],
      signals: [{ level: "warn", count: 1 }],
      deliveries: [{ state: "delivered", count: 2 }],
      feedback: [{ rating: "good", failure_mode: "unclassified", count: 1 }],
    });
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[3]?.[0]).toContain("obligation.state");
    expect(query.mock.calls[3]?.[0]).toContain("interval '5 minutes'");
    expect(query.mock.calls.every((call) => call[0].includes("qualityCohort"))).toBe(true);
    expect(query.mock.calls.every((call) => call[1]?.[0] === 48 && call[1]?.[1] === "revision-1")).toBe(true);
  });

  it("finds the most recently active prior revision", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ revision: "revision-0" }] });
    await expect(findBaselineRevision({ query } as unknown as DbPool, "revision-1", 48)).resolves.toBe("revision-0");
    expect(query.mock.calls[0]?.[1]).toEqual([48, "revision-1"]);
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

  it("treats classified bad feedback as an answer incident rate, not a self-selected feedback ratio", () => {
    const assessment = assessRevisionQuality(quality({ succeeded: 10 }, {
      feedback: [{ rating: "bad", failure_mode: "wrong_answer", count: 3 }],
    }));
    expect(assessment.status).toBe("fail");
    expect(assessment.violations).toContain("bad feedback per answer 30.0% exceeds 20.0%");
  });

  it("separates recovered validation retries from terminal capability failures", () => {
    const assessment = assessRevisionQuality(quality({ succeeded: 10 }, {
      tools: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }],
    }));
    expect(assessment.metrics).toMatchObject({ toolCalls: 1, toolAttempts: 4, toolRetries: 3, recoveredValidationRetries: 3, toolFailures: 0 });
    expect(assessment.violations).not.toEqual(expect.arrayContaining([expect.stringContaining("tool failure rate")]));
  });
});

function quality(
  statuses: Record<string, number>,
  overrides: { p95Ms?: number; tools?: Record<string, unknown>[]; signals?: Record<string, unknown>[]; deliveries?: Record<string, unknown>[]; feedback?: Record<string, unknown>[] } = {},
): RevisionQuality {
  return {
    revision: "test-revision",
    windowHours: 48,
    generatedAt: new Date(0).toISOString(),
    answers: Object.entries(statuses).map(([status, count]) => ({ model: "test/model", status, count, p95_ms: overrides.p95Ms ?? 100 })),
    tools: overrides.tools ?? [{ tool: "web__run", status: "ok", count: 10 }],
    signals: overrides.signals ?? [],
    deliveries: overrides.deliveries ?? [{ state: "delivered", count: 1 }],
    feedback: overrides.feedback ?? [{ rating: "good", failure_mode: "unclassified", count: 5 }],
  };
}
