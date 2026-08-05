import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelReminder, createReminder, listMyReminders } from "../../src/tools/reminderTools.js";
import { toolRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("reminder tools", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-08-05T12:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("creates a durable requester-owned reminder and schedules its wakeup", async () => {
    const repo = reminderRepo();
    const jobs = { enqueueReminderDelivery: vi.fn(async () => "job") };
    const ctx = context(repo, jobs);

    const result = await createReminder(ctx, {
      reminder: "call Mom",
      scheduledFor: "2026-08-06T09:00:00-04:00",
      timezone: "America/New_York",
    });

    expect(result).toEqual(expect.objectContaining({ status: "ok", content: expect.stringContaining("2026-08-06 09:00 EDT") }));
    expect(repo.createReminder).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild",
      channelId: "channel",
      requesterId: "user",
      sourceMessageId: "message",
      reminderText: "call Mom",
      timezone: "America/New_York",
      scheduledFor: new Date("2026-08-06T13:00:00.000Z"),
    }));
    expect(jobs.enqueueReminderDelivery).toHaveBeenCalledWith("r_existing", new Date("2026-08-06T13:00:00.000Z"));
  });

  it("keeps the durable reminder successful when the optional wakeup enqueue fails", async () => {
    const repo = reminderRepo();
    const ctx = context(repo, { enqueueReminderDelivery: vi.fn(async () => { throw new Error("queue down"); }) });

    await expect(createReminder(ctx, {
      reminder: "call Mom",
      scheduledFor: "2026-08-06T09:00:00-04:00",
    })).resolves.toEqual(expect.objectContaining({ status: "ok" }));
  });

  it("rejects ambiguous or past instants without writing", async () => {
    const repo = reminderRepo();
    const ctx = context(repo);

    await expect(createReminder(ctx, { reminder: "thing", scheduledFor: "tomorrow at 9" }))
      .resolves.toEqual(expect.objectContaining({ errorCode: "reminder_time_invalid" }));
    await expect(createReminder(ctx, { reminder: "thing", scheduledFor: "2026-08-05T11:00:00Z" }))
      .resolves.toEqual(expect.objectContaining({ errorCode: "reminder_time_not_future" }));
    await expect(createReminder(ctx, { reminder: "thing", scheduledFor: "2026-02-30T09:00:00Z" }))
      .resolves.toEqual(expect.objectContaining({ errorCode: "reminder_time_invalid" }));
    expect(repo.createReminder).not.toHaveBeenCalled();
  });

  it("lists and cancels only through immutable requester and guild scope", async () => {
    const repo = reminderRepo();
    const ctx = context(repo);

    const listed = await listMyReminders(ctx);
    const cancelled = await cancelReminder(ctx, { reminderId: "r_existing" });

    expect(repo.listScheduledRemindersForRequester).toHaveBeenCalledWith({ guildId: "guild", requesterId: "user", limit: 25 });
    expect(repo.cancelReminderForRequester).toHaveBeenCalledWith({ reminderId: "r_existing", guildId: "guild", requesterId: "user" });
    expect(listed.content).toContain("call Mom");
    expect(cancelled.content).toContain("Cancelled reminder");
  });

  it("does not expose model-supplied requester or channel identity", () => {
    for (const name of ["createReminder", "listMyReminders", "cancelReminder"] as const) {
      const contract = toolRegistry.find((tool) => tool.name === name);
      expect(contract?.parameters.properties).not.toHaveProperty("user_id");
      expect(contract?.parameters.properties).not.toHaveProperty("channel_id");
    }
  });
});

function reminderRepo() {
  const reminder = {
    reminderId: "r_existing",
    requestKey: "key",
    guildId: "guild",
    channelId: "channel",
    requesterId: "user",
    sourceMessageId: "message",
    reminderText: "call Mom",
    timezone: "America/New_York",
    scheduledFor: new Date("2026-08-06T13:00:00.000Z"),
    status: "scheduled",
    deliveryAttempts: 0,
    claimedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    deliveryChannelId: null,
    deliveryMessageId: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    createReminder: vi.fn(async () => reminder),
    listScheduledRemindersForRequester: vi.fn(async () => [reminder]),
    cancelReminderForRequester: vi.fn(async () => reminder),
    getUserPreference: vi.fn(async () => undefined),
    auditTool: vi.fn(async () => undefined),
  };
}

function context(repo: Record<string, unknown>, jobs?: Record<string, unknown>): ToolContext {
  return {
    config: {},
    repo,
    openRouter: {},
    jobs,
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    requestId: "request",
    requestMessageId: "message",
    mutationAuthorizedByCurrentInput: true,
  } as unknown as ToolContext;
}
