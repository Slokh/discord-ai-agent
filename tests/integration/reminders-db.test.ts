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

    await expect(repo.listDueReminderIds({ now: new Date(now.getTime() + 6 * 60_000) }))
      .resolves.toContain("r_due");
    await expect(repo.claimReminderForDelivery({ reminderId: "r_due", now: new Date(now.getTime() + 6 * 60_000) }))
      .resolves.toEqual(expect.objectContaining({ deliveryAttempts: 2 }));
    await expect(repo.markReminderDelivered({ reminderId: "r_due", channelId: "channel", messageId: "message" }))
      .resolves.toBe(true);
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
