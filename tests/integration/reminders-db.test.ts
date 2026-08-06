import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";
import { createAppDatabase } from "../../src/db/repositories.js";
import { runDataRetentionOnce } from "../../src/observability/dataRetention.js";
import { collectScheduleHealthObservation, scheduleHealthDetectionInputs } from "../../src/observability/scheduleHealth.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";
let database: IsolatedTestDatabase;

describe.skipIf(!runDbTests)("durable reminder repository", () => {
  beforeAll(async () => { database = await createIsolatedTestDatabase("reminders"); });
  afterAll(async () => { await database.cleanup(); });

  it("creates idempotently and scopes list and cancellation to requester plus guild", async () => {
    const repo = createAppDatabase(database.pool);
    const scheduledFor = new Date(Date.now() + 60_000);
    const first = await repo.createReminder(reminderInput("r_one", "request-key", scheduledFor));
    const duplicate = await repo.createReminder(reminderInput("r_duplicate", "request-key", scheduledFor));
    await repo.createReminder({ ...reminderInput("r_other", "other-key", scheduledFor), requesterId: "other" });

    expect(first).toEqual(expect.objectContaining({ reminderId: "r_one", deliveryKind: "notification" }));
    expect(duplicate.reminderId).toBe("r_one");
    await expect(repo.listSchedulesForRequester({ guildId: "guild", requesterId: "user" }))
      .resolves.toEqual([expect.objectContaining({ reminderId: "r_one" })]);
    await expect(repo.cancelReminderForRequester({ reminderId: "r_other", guildId: "guild", requesterId: "user" }))
      .resolves.toBeUndefined();
    await expect(repo.cancelReminderForRequester({ reminderId: "r_one", guildId: "guild", requesterId: "user" }))
      .resolves.toEqual(expect.objectContaining({ status: "cancelled" }));
  });

  it("atomically claims due reminders and recovers stale delivery claims", async () => {
    const repo = createAppDatabase(database.pool);
    const now = new Date();
    await repo.createReminder(reminderInput("r_due", "due-key", new Date(now.getTime() - 1_000)));

    const claims = await Promise.all(Array.from({ length: 8 }, () => repo.claimReminderForDelivery({ reminderId: "r_due", now })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toEqual(expect.objectContaining({ status: "delivering", deliveryAttempts: 1 }));

    await expect(repo.listDueReminderWakeups({ now: new Date(now.getTime() + 6 * 60_000) }))
      .resolves.toContainEqual(expect.objectContaining({ reminderId: "r_due", occurrenceSequence: 0 }));
    await expect(repo.claimReminderForDelivery({ reminderId: "r_due", now: new Date(now.getTime() + 6 * 60_000) }))
      .resolves.toEqual(expect.objectContaining({ deliveryAttempts: 2 }));
    await expect(repo.completeReminderOccurrence({
      reminderId: "r_due", channelId: "channel", messageId: "message", outcome: "succeeded",
    })).resolves.toEqual(expect.objectContaining({
      status: "delivered", lastRunStatus: "succeeded", consecutiveFailures: 0,
    }));

    await repo.createReminder({
      ...reminderInput("r_agent_due", "agent-due-key", new Date(now.getTime() - 1_000)),
      deliveryKind: "agent",
    });
    await repo.claimReminderForDelivery({ reminderId: "r_agent_due", now });
    await expect(repo.listDueReminderWakeups({ now: new Date(now.getTime() + 6 * 60_000) }))
      .resolves.not.toContainEqual(expect.objectContaining({ reminderId: "r_agent_due" }));
    await expect(repo.listDueReminderWakeups({ now: new Date(now.getTime() + 16 * 60_000) }))
      .resolves.toContainEqual(expect.objectContaining({ reminderId: "r_agent_due" }));
  });

  it("advances, pauses, resumes, and cancels one durable recurring series", async () => {
    const repo = createAppDatabase(database.pool);
    const first = new Date("2026-08-07T09:00:00Z");
    await repo.createReminder({
      ...reminderInput("r_recurring", "recurring-key", first),
      recurrence: { frequency: "weekly", interval: 1, localTime: "09:00", anchorDate: "2026-08-07", weekdays: [1, 5] },
    });

    await repo.claimReminderForDelivery({ reminderId: "r_recurring", now: first });
    const advanced = await repo.completeReminderOccurrence({
      reminderId: "r_recurring",
      channelId: "channel",
      messageId: "occurrence-0",
      outcome: "succeeded",
      executionId: "scheduled-request-execution:r_recurring:0",
      nextScheduledFor: new Date("2026-08-10T09:00:00Z"),
    });
    expect(advanced).toEqual(expect.objectContaining({
      status: "scheduled",
      occurrenceSequence: 1,
      deliveryAttempts: 0,
      scheduledFor: new Date("2026-08-10T09:00:00Z"),
      lastRunStatus: "succeeded",
      lastRunExecutionId: "scheduled-request-execution:r_recurring:0",
    }));
    await expect(repo.getReminderForDeliveryMessage({
      messageId: "occurrence-0",
      channelId: "channel",
      guildId: "guild",
      requesterId: "user",
    })).resolves.toEqual(expect.objectContaining({ reminderId: "r_recurring" }));
    await expect(repo.getReminderForDeliveryMessage({
      messageId: "occurrence-0",
      channelId: "channel",
      guildId: "guild",
      requesterId: "other",
    })).resolves.toBeUndefined();

    await expect(repo.pauseReminderForRequester({ reminderId: "r_recurring", guildId: "guild", requesterId: "other" }))
      .resolves.toBeUndefined();
    await expect(repo.pauseReminderForRequester({ reminderId: "r_recurring", guildId: "guild", requesterId: "user" }))
      .resolves.toEqual(expect.objectContaining({ status: "paused", pausedAt: expect.any(Date) }));
    await expect(repo.listDueReminderWakeups({ now: new Date("2026-08-20T00:00:00Z") }))
      .resolves.not.toContainEqual(expect.objectContaining({ reminderId: "r_recurring" }));
    await expect(repo.resumeReminderForRequester({
      reminderId: "r_recurring",
      guildId: "guild",
      requesterId: "user",
      scheduledFor: new Date("2026-08-21T09:00:00Z"),
    })).resolves.toEqual(expect.objectContaining({ status: "scheduled", pausedAt: null }));
    await expect(repo.cancelReminderForRequester({ reminderId: "r_recurring", guildId: "guild", requesterId: "user" }))
      .resolves.toEqual(expect.objectContaining({ status: "cancelled" }));
  });

  it("updates active reminders atomically and makes obsolete wakeups no-op", async () => {
    const repo = createAppDatabase(database.pool);
    const oldTime = new Date("2026-08-05T09:00:00Z");
    const newTime = new Date("2026-08-06T10:00:00Z");
    await repo.createReminder(reminderInput("r_update", "update-key", oldTime));

    const updated = await repo.updateReminderForRequester({
      reminderId: "r_update",
      guildId: "guild",
      requesterId: "user",
      reminderText: "updated text",
      timezone: "America/New_York",
      scheduledFor: newTime,
      recurrence: { frequency: "daily", interval: 1, localTime: "06:00", anchorDate: "2026-08-06" },
      deliveryKind: "agent",
    });

    expect(updated).toEqual(expect.objectContaining({
      reminderText: "updated text",
      deliveryKind: "agent",
      timezone: "America/New_York",
      scheduledFor: newTime,
      recurrence: expect.objectContaining({ frequency: "daily", localTime: "06:00" }),
    }));
    await expect(repo.claimReminderForDelivery({ reminderId: "r_update", now: oldTime }))
      .resolves.toBeUndefined();
    await expect(repo.updateReminderForRequester({
      reminderId: "r_update",
      guildId: "guild",
      requesterId: "other",
      reminderText: "not yours",
      timezone: "UTC",
      scheduledFor: newTime,
      recurrence: null,
      deliveryKind: "notification",
    })).resolves.toBeUndefined();

    await repo.createReminder({
      ...reminderInput("r_convert", "convert-key", newTime),
      recurrence: { frequency: "daily", interval: 1, localTime: "10:00", anchorDate: "2026-08-06" },
    });
    await repo.pauseReminderForRequester({ reminderId: "r_convert", guildId: "guild", requesterId: "user" });
    await expect(repo.updateReminderForRequester({
      reminderId: "r_convert",
      guildId: "guild",
      requesterId: "user",
      reminderText: "one last time",
      timezone: "UTC",
      scheduledFor: newTime,
      recurrence: null,
      deliveryKind: "notification",
    })).resolves.toEqual(expect.objectContaining({ status: "scheduled", pausedAt: null, recurrence: null }));
  });

  it("projects occurrence health and auto-pauses a recurring schedule after three failed runs", async () => {
    const repo = createAppDatabase(database.pool);
    let scheduledFor = new Date("2026-08-06T09:00:00Z");
    await repo.createReminder({
      ...reminderInput("r_unhealthy", "unhealthy-key", scheduledFor),
      deliveryKind: "agent",
      recurrence: { frequency: "daily", interval: 1, localTime: "09:00", anchorDate: "2026-08-06" },
    });

    for (let occurrence = 0; occurrence < 3; occurrence += 1) {
      await repo.claimReminderForDelivery({ reminderId: "r_unhealthy", now: scheduledFor });
      const nextScheduledFor = new Date(scheduledFor.getTime() + 24 * 60 * 60_000);
      const completed = await repo.completeReminderOccurrence({
        reminderId: "r_unhealthy",
        channelId: "channel",
        messageId: `failed-${occurrence}`,
        outcome: "failed",
        executionId: `scheduled-request-execution:r_unhealthy:${occurrence}`,
        nextScheduledFor,
      });
      expect(completed).toEqual(expect.objectContaining({
        status: occurrence === 2 ? "paused" : "scheduled",
        occurrenceSequence: occurrence + 1,
        consecutiveFailures: occurrence + 1,
        lastRunStatus: "failed",
      }));
      scheduledFor = nextScheduledFor;
    }

    const paused = (await repo.listSchedulesForRequester({ guildId: "guild", requesterId: "user" }))
      .find((reminder) => reminder.reminderId === "r_unhealthy");
    expect(paused).toEqual(expect.objectContaining({
      reminderId: "r_unhealthy",
      status: "paused",
      autoPausedAt: expect.any(Date),
      deliveryMessageId: "failed-2",
    }));
    const runtime = new AgentRuntimeRepository(database.pool);
    for (const schedule of ["healthy", "partial", "failed", "r_unhealthy"]) {
      await runtime.upsertSession({
        sessionId: `schedule-health-${schedule}`,
        threadKey: `schedule-health-${schedule}`,
        request: "schedule health fixture",
        status: "succeeded",
        metadata: { appRevision: "test-revision", qualityCohort: "scheduled" },
      });
    }
    const outcomes = [
      { executionId: "schedule-health-success", scheduleId: "healthy", outcome: "succeeded" },
      { executionId: "schedule-health-partial-1", scheduleId: "partial", outcome: "partial" },
      { executionId: "schedule-health-partial-2", scheduleId: "partial", outcome: "partial" },
      { executionId: "schedule-health-partial-3", scheduleId: "partial", outcome: "partial" },
      { executionId: "schedule-health-failed", scheduleId: "failed", outcome: "failed" },
      { executionId: "scheduled-request-execution:r_unhealthy:2", scheduleId: "r_unhealthy", outcome: "failed" },
    ] as const;
    for (const outcome of outcomes) {
      await runtime.createExecution({
        executionId: outcome.executionId,
        sessionId: `schedule-health-${outcome.scheduleId}`,
        harness: "nanocodex",
        status: "succeeded",
        metadata: {
          appRevision: "test-revision",
          qualityCohort: "scheduled",
          scheduleId: outcome.scheduleId,
          scheduledOutcome: outcome.outcome,
        },
      });
    }
    const observation = await collectScheduleHealthObservation(database.pool, "test-revision", 48);
    expect(observation.health).toEqual(expect.objectContaining({
      status: "needs_attention",
      runs: { succeeded: 1, partial: 3, failed: 2 },
      issues: expect.objectContaining({ repeatedPartial: 1, autoPaused: 1 }),
    }));
    expect(scheduleHealthDetectionInputs(observation.health, observation.privateIssues).map((input) => input.stableCode))
      .toEqual(expect.arrayContaining([
        "schedule-health:run_failed",
        "schedule-health:repeated_partial",
        "schedule-health:auto_paused",
      ]));
    await expect(repo.resumeReminderForRequester({
      reminderId: "r_unhealthy",
      guildId: "guild",
      requesterId: "user",
      scheduledFor,
    })).resolves.toEqual(expect.objectContaining({
      status: "scheduled",
      autoPausedAt: null,
      consecutiveFailures: 0,
    }));
  });

  it("deletes requester data and expires only terminal reminder history", async () => {
    const repo = createAppDatabase(database.pool);
    const old = new Date("2026-01-01T00:00:00Z");
    await repo.createReminder(reminderInput("r_private", "private-key", new Date(Date.now() + 60_000)));
    await repo.requestUserDeletion("user");
    await expect(repo.listSchedulesForRequester({ guildId: "guild", requesterId: "user" })).resolves.toEqual([]);

    await repo.createReminder(reminderInput("r_terminal", "terminal-key", new Date(Date.now() - 60_000)));
    await repo.claimReminderForDelivery({ reminderId: "r_terminal" });
    await repo.markReminderFailed({ reminderId: "r_terminal", errorCode: "test" });
    await database.pool.query("UPDATE scheduled_reminders SET updated_at = $1 WHERE reminder_id = 'r_terminal'", [old]);
    const result = await runDataRetentionOnce({
      db: database.pool,
      config: { runtimeEventsDays: 0, auditDays: 0, runtimeSessionsDays: 0, terminalRemindersDays: 30 },
      now: new Date("2026-08-05T00:00:00Z"),
    });
    expect(result.scheduledReminders).toBe(1);
  });
});

function reminderInput(reminderId: string, requestKey: string, scheduledFor: Date) {
  return {
    reminderId,
    requestKey,
    guildId: "guild",
    channelId: "channel",
    requesterId: "user",
    sourceMessageId: "source",
    reminderText: "remember this",
    timezone: "UTC",
    scheduledFor,
  };
}
