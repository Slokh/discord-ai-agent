import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppDatabase } from "../../src/db/repositories.js";
import { runDataRetentionOnce } from "../../src/observability/dataRetention.js";
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

    expect(first.reminderId).toBe("r_one");
    expect(duplicate.reminderId).toBe("r_one");
    await expect(repo.listScheduledRemindersForRequester({ guildId: "guild", requesterId: "user" }))
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
    await expect(repo.markReminderDelivered({ reminderId: "r_due", channelId: "channel", messageId: "message" }))
      .resolves.toEqual(expect.objectContaining({ status: "delivered" }));
  });

  it("advances, pauses, resumes, and cancels one durable recurring series", async () => {
    const repo = createAppDatabase(database.pool);
    const first = new Date("2026-08-07T09:00:00Z");
    await repo.createReminder({
      ...reminderInput("r_recurring", "recurring-key", first),
      recurrence: { frequency: "weekly", interval: 1, localTime: "09:00", anchorDate: "2026-08-07", weekdays: [1, 5] },
    });

    await repo.claimReminderForDelivery({ reminderId: "r_recurring", now: first });
    const advanced = await repo.markReminderDelivered({
      reminderId: "r_recurring",
      channelId: "channel",
      messageId: "occurrence-0",
      nextScheduledFor: new Date("2026-08-10T09:00:00Z"),
    });
    expect(advanced).toEqual(expect.objectContaining({
      status: "scheduled",
      occurrenceSequence: 1,
      deliveryAttempts: 0,
      scheduledFor: new Date("2026-08-10T09:00:00Z"),
    }));

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

  it("deletes requester data and expires only terminal reminder history", async () => {
    const repo = createAppDatabase(database.pool);
    const old = new Date("2026-01-01T00:00:00Z");
    await repo.createReminder(reminderInput("r_private", "private-key", new Date(Date.now() + 60_000)));
    await repo.requestUserDeletion("user");
    await expect(repo.listScheduledRemindersForRequester({ guildId: "guild", requesterId: "user" })).resolves.toEqual([]);

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
