import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import {
  collectScheduleHealthObservation,
  scheduleHealthDetectionInputs,
} from "../../src/observability/scheduleHealth.js";

describe("schedule health", () => {
  it("projects content-free run health and creates stable private detections", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { execution_id: "success", status: "succeeded", schedule_id: "schedule-success", scheduled_outcome: "succeeded" },
        { execution_id: "partial-1", status: "succeeded", schedule_id: "schedule-partial", response_status: "partial" },
        { execution_id: "partial-2", status: "succeeded", schedule_id: "schedule-partial", scheduled_outcome: "partial" },
        { execution_id: "partial-3", status: "succeeded", schedule_id: "schedule-partial", scheduled_outcome: "partial" },
        { execution_id: "failed", status: "succeeded", schedule_id: "schedule-paused", scheduled_outcome: "failed" },
      ] })
      .mockResolvedValueOnce({ rows: [
        { reminder_id: "schedule-overdue", last_run_execution_id: null, issue: "overdue" },
        { reminder_id: "schedule-stuck", last_run_execution_id: "stuck-execution", issue: "stuck" },
        { reminder_id: "schedule-paused", last_run_execution_id: "failed", issue: "auto_paused" },
      ] });

    const observation = await collectScheduleHealthObservation(
      { query } as unknown as DbPool,
      "revision-1",
      48,
    );
    const detections = scheduleHealthDetectionInputs(observation.health, observation.privateIssues);

    expect(observation.health).toMatchObject({
      revision: "revision-1",
      windowHours: 48,
      status: "needs_attention",
      runs: { succeeded: 1, partial: 3, failed: 1 },
      issues: { repeatedPartial: 1, overdue: 1, stuck: 1, autoPaused: 1 },
    });
    expect(JSON.stringify(observation.health)).not.toContain("schedule-");
    expect(detections.map((detection) => detection.stableCode)).toEqual([
      "schedule-health:repeated_partial",
      "schedule-health:overdue",
      "schedule-health:stuck",
      "schedule-health:auto_paused",
    ]);
    expect(JSON.stringify(detections)).not.toContain("schedule-overdue");
    expect(JSON.stringify(detections)).not.toContain("schedule-stuck");
    expect(JSON.stringify(detections)).not.toContain("schedule-paused");
    expect(query.mock.calls[0]?.[1]).toEqual([48, "revision-1"]);
    expect(query.mock.calls[1]?.[1]).toEqual([48]);
  });

  it("falls back to terminal execution state when no explicit response outcome was retained", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ execution_id: "cancelled", status: "cancelled", schedule_id: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const observation = await collectScheduleHealthObservation(
      { query } as unknown as DbPool,
      "revision-1",
      24,
    );

    expect(observation.health.runs).toEqual({ succeeded: 0, partial: 0, failed: 1 });
    expect(scheduleHealthDetectionInputs(observation.health, observation.privateIssues)[0]).toMatchObject({
      stableCode: "schedule-health:run_failed",
      executionId: "cancelled",
    });
  });
});
