import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import {
  collectScheduleHealthObservation,
  scheduleHealthDetectionInputs,
  scheduleHealthReference,
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
        { reminder_id: "schedule-overdue", last_run_execution_id: null, status: "scheduled", overdue: true, stuck: false, auto_paused: false },
        { reminder_id: "schedule-stuck", last_run_execution_id: "stuck-execution", status: "delivering", overdue: false, stuck: true, auto_paused: false },
        {
          reminder_id: "schedule-paused", last_run_execution_id: "failed", status: "paused", overdue: false, stuck: false, auto_paused: true,
          guild_id: "guild-1", channel_id: "channel-1", requester_id: "member-1", source_message_id: "message-1",
          delivery_kind: "agent", recurrence: { frequency: "daily" }, delivery_attempts: 3, last_error_code: "provider_timeout",
          last_run_status: "failed", consecutive_failures: 3,
        },
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
      scheduleHealthReference("repeated_partial", "schedule-partial"),
      scheduleHealthReference("overdue", "schedule-overdue"),
      scheduleHealthReference("stuck", "schedule-stuck"),
      scheduleHealthReference("auto_paused", "schedule-paused"),
    ]);
    expect(observation.proofStatuses).toMatchObject({
      [scheduleHealthReference("repeated_partial", "schedule-partial")]: "failed",
      [scheduleHealthReference("overdue", "schedule-overdue")]: "failed",
      [scheduleHealthReference("stuck", "schedule-stuck")]: "failed",
      [scheduleHealthReference("auto_paused", "schedule-paused")]: "failed",
      [scheduleHealthReference("run_failed", "schedule-success")]: "passed",
    });
    expect(JSON.stringify(detections)).not.toContain("schedule-overdue");
    expect(JSON.stringify(detections)).not.toContain("schedule-stuck");
    expect(JSON.stringify(detections)).not.toContain("schedule-paused");
    expect(detections.at(-1)).toMatchObject({
      affectedMemberContext: { guildId: "guild-1", channelId: "channel-1", messageId: "message-1", userId: "member-1" },
      metadata: { operationalEvidence: { status: "paused", deliveryKind: "agent", recurring: true, consecutiveFailures: 3 } },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([48, "revision-1"]);
    expect(query.mock.calls[1]?.[1]).toEqual([48]);
  });

  it("falls back to terminal execution state when no explicit response outcome was retained", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ execution_id: "cancelled", status: "cancelled", schedule_id: "schedule-cancelled" }] })
      .mockResolvedValueOnce({ rows: [] });

    const observation = await collectScheduleHealthObservation(
      { query } as unknown as DbPool,
      "revision-1",
      24,
    );

    expect(observation.health.runs).toEqual({ succeeded: 0, partial: 0, failed: 1 });
    expect(scheduleHealthDetectionInputs(observation.health, observation.privateIssues)[0]).toMatchObject({
      stableCode: scheduleHealthReference("run_failed", "schedule-cancelled"),
      executionId: "cancelled",
    });
  });

  it("requires schedule-specific traffic before recovery can pass", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { execution_id: "success-1", status: "succeeded", schedule_id: "recovered", scheduled_outcome: "succeeded" },
        { execution_id: "success-2", status: "succeeded", schedule_id: "recovered", scheduled_outcome: "succeeded" },
        { execution_id: "success-3", status: "succeeded", schedule_id: "recovered", scheduled_outcome: "succeeded" },
      ] })
      .mockResolvedValueOnce({ rows: [
        { reminder_id: "recovered", status: "scheduled", overdue: false, stuck: false, auto_paused: false },
        { reminder_id: "idle", status: "scheduled", overdue: false, stuck: false, auto_paused: false },
        { reminder_id: "paused-from-prior", status: "paused", overdue: false, stuck: false, auto_paused: true },
      ] });

    const observation = await collectScheduleHealthObservation(
      { query } as unknown as DbPool,
      "revision-2",
      48,
    );

    expect(observation.proofStatuses).toMatchObject({
      [scheduleHealthReference("run_failed", "recovered")]: "passed",
      [scheduleHealthReference("repeated_partial", "recovered")]: "passed",
      [scheduleHealthReference("auto_paused", "recovered")]: "passed",
      [scheduleHealthReference("run_failed", "idle")]: "inconclusive",
      [scheduleHealthReference("repeated_partial", "idle")]: "inconclusive",
      [scheduleHealthReference("auto_paused", "idle")]: "inconclusive",
      [scheduleHealthReference("auto_paused", "paused-from-prior")]: "inconclusive",
    });
  });
});
