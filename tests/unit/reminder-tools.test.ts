import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import { createReminder, listMyReminders, manageReminder } from "../../src/tools/reminderTools.js";
import { reminderToolHandlers } from "../../src/tools/handlers/reminders.js";
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
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "setReminder" }));
  });

  it("routes creation and mutation through one model-facing reminder setter", async () => {
    const repo = reminderRepo();
    const ctx = context(repo);

    await reminderToolHandlers.setReminder!(ctx, route({
      action: "create",
      reminder: "call Mom",
      scheduled_for: "2026-08-06T09:00:00-04:00",
    }));
    await reminderToolHandlers.setReminder!(ctx, route({ action: "cancel", reminder_id: "r_existing" }));
    const invalidCreate = await reminderToolHandlers.setReminder!(ctx, route({
      action: "create",
      reminder_id: "r_existing",
      reminder: "replace it",
      scheduled_for: "2026-08-06T09:00:00-04:00",
    }));

    expect(repo.createReminder).toHaveBeenCalledOnce();
    expect(repo.cancelReminderForRequester).toHaveBeenCalledWith({ reminderId: "r_existing", guildId: "guild", requesterId: "user" });
    expect(invalidCreate).toEqual(expect.objectContaining({ errorCode: "reminder_create_fields_invalid" }));
  });

  it("keeps the durable reminder successful when the optional wakeup enqueue fails", async () => {
    const repo = reminderRepo();
    const ctx = context(repo, { enqueueReminderDelivery: vi.fn(async () => { throw new Error("queue down"); }) });

    await expect(createReminder(ctx, {
      reminder: "call Mom",
      scheduledFor: "2026-08-06T09:00:00-04:00",
    })).resolves.toEqual(expect.objectContaining({ status: "ok" }));
  });

  it("creates a validated wall-clock recurrence", async () => {
    const repo = reminderRepo();
    const ctx = context(repo);

    const result = await createReminder(ctx, {
      reminder: "check the queue",
      scheduledFor: "2026-08-07T09:00:00-04:00",
      timezone: "America/New_York",
      recurrence: { frequency: "weekly", localTime: "09:00", weekdays: ["monday", "friday"] },
    });

    expect(result).toEqual(expect.objectContaining({ status: "ok", content: expect.stringContaining("weekly on Monday, Friday at 09:00") }));
    expect(repo.createReminder).toHaveBeenCalledWith(expect.objectContaining({
      recurrence: {
        frequency: "weekly",
        interval: 1,
        localTime: "09:00",
        anchorDate: "2026-08-07",
        weekdays: [1, 5],
      },
    }));
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

  it("lists and manages reminders only through immutable requester and guild scope", async () => {
    const repo = reminderRepo();
    const ctx = context(repo);

    const listed = await listMyReminders(ctx);
    const cancelled = await manageReminder(ctx, { action: "cancel", reminderId: "r_existing" });

    expect(repo.listScheduledRemindersForRequester).toHaveBeenCalledWith({ guildId: "guild", requesterId: "user", limit: 25 });
    expect(repo.cancelReminderForRequester).toHaveBeenCalledWith({ reminderId: "r_existing", guildId: "guild", requesterId: "user" });
    expect(listed.content).toContain("call Mom");
    expect(cancelled.content).toContain("Cancelled reminder");
  });

  it("resolves an omitted reminder ID only from the scoped direct reply notification", async () => {
    const repo = reminderRepo();
    const ctx = context(repo, undefined, { replyMessageId: "delivery-message" });

    const cancelled = await manageReminder(ctx, { action: "cancel" });

    expect(repo.getReminderForDeliveryMessage).toHaveBeenCalledWith({
      messageId: "delivery-message",
      channelId: "channel",
      guildId: "guild",
      requesterId: "user",
    });
    expect(repo.cancelReminderForRequester).toHaveBeenCalledWith({ reminderId: "r_existing", guildId: "guild", requesterId: "user" });
    expect(cancelled.content).toContain("Cancelled reminder");
  });

  it("does not treat an unscoped or non-bot reply as a reminder reference", async () => {
    const repo = reminderRepo();
    const ctx = context(repo, undefined, { replyMessageId: "other-message", replyChannelId: "other-channel" });

    const result = await manageReminder(ctx, { action: "cancel" });

    expect(result).toEqual(expect.objectContaining({ errorCode: "reminder_target_missing" }));
    expect(repo.getReminderForDeliveryMessage).not.toHaveBeenCalled();
    expect(repo.cancelReminderForRequester).not.toHaveBeenCalled();
  });

  it("pauses and resumes recurring reminders at the next future occurrence", async () => {
    const repo = reminderRepo({ recurring: true, status: "paused", scheduledFor: new Date("2026-08-05T11:00:00Z") });
    const jobs = { enqueueReminderDelivery: vi.fn(async () => "job") };
    const ctx = context(repo, jobs);

    await manageReminder(ctx, { action: "pause", reminderId: "r_existing" });
    const resumed = await manageReminder(ctx, { action: "resume", reminderId: "r_existing" });

    expect(repo.pauseReminderForRequester).toHaveBeenCalledWith({ reminderId: "r_existing", guildId: "guild", requesterId: "user" });
    expect(repo.resumeReminderForRequester).toHaveBeenCalledWith(expect.objectContaining({
      reminderId: "r_existing",
      scheduledFor: new Date("2026-08-06T13:00:00Z"),
    }));
    expect(jobs.enqueueReminderDelivery).toHaveBeenCalledWith("r_existing", new Date("2026-08-06T13:00:00Z"));
    expect(resumed.content).toContain("Resumed reminder");
  });

  it("atomically updates a one-shot reminder and schedules its new wakeup", async () => {
    const repo = reminderRepo();
    const jobs = { enqueueReminderDelivery: vi.fn(async () => "job") };
    const ctx = context(repo, jobs);

    const updated = await manageReminder(ctx, {
      action: "update",
      reminderId: "r_existing",
      reminder: "call Dad",
      scheduledFor: "2026-08-07T10:00:00-04:00",
      timezone: "America/New_York",
    });

    expect(repo.updateReminderForRequester).toHaveBeenCalledWith(expect.objectContaining({
      reminderId: "r_existing",
      guildId: "guild",
      requesterId: "user",
      reminderText: "call Dad",
      scheduledFor: new Date("2026-08-07T14:00:00Z"),
      recurrence: null,
    }));
    expect(jobs.enqueueReminderDelivery).toHaveBeenCalledWith("r_existing", new Date("2026-08-07T14:00:00Z"));
    expect(updated).toEqual(expect.objectContaining({ status: "ok", content: expect.stringContaining("call Dad") }));
  });

  it("requires explicit next-occurrence versus series scope for recurring time changes", async () => {
    const repo = reminderRepo({ recurring: true });
    const ctx = context(repo);

    const ambiguous = await manageReminder(ctx, {
      action: "update",
      reminderId: "r_existing",
      scheduledFor: "2026-08-07T10:00:00-04:00",
    });

    expect(ambiguous).toEqual(expect.objectContaining({ errorCode: "reminder_update_scope_required" }));
    expect(repo.updateReminderForRequester).not.toHaveBeenCalled();
  });

  it("moves one occurrence without changing its recurring series rule", async () => {
    const repo = reminderRepo({ recurring: true });
    const jobs = { enqueueReminderDelivery: vi.fn(async () => "job") };
    const ctx = context(repo, jobs);

    const updated = await manageReminder(ctx, {
      action: "update",
      reminderId: "r_existing",
      scheduledFor: "2026-08-07T10:00:00-04:00",
      updateScope: "next_occurrence",
    });

    expect(repo.updateReminderForRequester).toHaveBeenCalledWith(expect.objectContaining({
      scheduledFor: new Date("2026-08-07T14:00:00Z"),
      recurrence: expect.objectContaining({ frequency: "daily", localTime: "09:00" }),
    }));
    expect(updated.content).toContain("series rule is unchanged");
  });

  it("replaces a recurring series rule from one matching future first occurrence", async () => {
    const repo = reminderRepo({ recurring: true });
    const ctx = context(repo);

    await manageReminder(ctx, {
      action: "update",
      reminderId: "r_existing",
      scheduledFor: "2026-08-07T10:00:00-04:00",
      timezone: "America/New_York",
      updateScope: "series",
      recurrence: { frequency: "weekly", localTime: "10:00", weekdays: ["monday", "friday"] },
    });

    expect(repo.updateReminderForRequester).toHaveBeenCalledWith(expect.objectContaining({
      recurrence: {
        frequency: "weekly",
        interval: 1,
        localTime: "10:00",
        anchorDate: "2026-08-07",
        weekdays: [1, 5],
      },
    }));
  });

  it("does not expose model-supplied requester or channel identity", () => {
    for (const name of ["setReminder", "listMyReminders"] as const) {
      const contract = toolRegistry.find((tool) => tool.name === name);
      expect(contract?.parameters.properties).not.toHaveProperty("user_id");
      expect(contract?.parameters.properties).not.toHaveProperty("channel_id");
    }
  });
});

function reminderRepo(input: { recurring?: boolean; status?: string; scheduledFor?: Date } = {}) {
  const recurrence = input.recurring ? {
    frequency: "daily" as const,
    interval: 1,
    localTime: "09:00",
    anchorDate: "2026-08-04",
  } : null;
  const reminder = {
    reminderId: "r_existing",
    requestKey: "key",
    guildId: "guild",
    channelId: "channel",
    requesterId: "user",
    sourceMessageId: "message",
    reminderText: "call Mom",
    timezone: "America/New_York",
    scheduledFor: input.scheduledFor ?? new Date("2026-08-06T13:00:00.000Z"),
    recurrence,
    occurrenceSequence: 0,
    status: input.status ?? "scheduled",
    deliveryAttempts: 0,
    claimedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    pausedAt: input.status === "paused" ? new Date() : null,
    deliveryChannelId: null,
    deliveryMessageId: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    createReminder: vi.fn(async (created: Record<string, unknown>) => ({ ...reminder, ...created, reminderId: reminder.reminderId })),
    listScheduledRemindersForRequester: vi.fn(async () => [reminder]),
    cancelReminderForRequester: vi.fn(async () => reminder),
    pauseReminderForRequester: vi.fn(async () => ({ ...reminder, status: "paused", pausedAt: new Date() })),
    getReminderForRequester: vi.fn(async () => reminder),
    getReminderForDeliveryMessage: vi.fn(async () => reminder),
    updateReminderForRequester: vi.fn(async (updated: Record<string, unknown>) => ({ ...reminder, ...updated })),
    resumeReminderForRequester: vi.fn(async (resumed: { scheduledFor: Date }) => ({ ...reminder, ...resumed, status: "scheduled", pausedAt: null })),
    getUserPreference: vi.fn(async () => undefined),
    auditTool: vi.fn(async () => undefined),
  };
}

function context(
  repo: Record<string, unknown>,
  jobs?: Record<string, unknown>,
  reply?: { replyMessageId: string; replyChannelId?: string; authorIsBot?: boolean },
): ToolContext {
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
    replyContext: reply ? {
      messageId: reply.replyMessageId,
      channelId: reply.replyChannelId ?? "channel",
      guildId: "guild",
      authorId: "bot",
      authorDisplayName: "Bot",
      authorIsBot: reply.authorIsBot ?? true,
      content: "<@user> reminder: call Mom",
      attachmentSummaries: [],
      attachments: [],
      createdAt: new Date().toISOString(),
      url: null,
      rootMessageId: reply.replyMessageId,
      chain: [],
    } : undefined,
    mutationAuthorizedByCurrentInput: true,
  } as unknown as ToolContext;
}

function route(args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool", name: "setReminder", arguments: args, argumentsText: JSON.stringify(args) };
}
