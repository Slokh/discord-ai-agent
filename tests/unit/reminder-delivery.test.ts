import { afterEach, describe, expect, it, vi } from "vitest";
import { createReminderDeliveryRunner } from "../../src/reminders/reminderDelivery.js";

describe("reminder delivery", () => {
  afterEach(() => vi.useRealTimers());

  it("revalidates visibility, mentions only the requester, and marks delivery", async () => {
    const repo = deliveryRepo();
    const send = vi.fn(async (payload) => ({ id: "delivered-message", channelId: "channel", payload }));
    const client = discordClient({ canView: true, send });
    const runner = createReminderDeliveryRunner({ client: client as never, config: { maxReplyChars: 1800 } as never, repo: repo as never });

    await runner.deliver("r_1");

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: "<@user> reminder: check the oven",
      allowedMentions: { parse: [], users: ["user"], repliedUser: false },
      nonce: expect.stringMatching(/^[a-f0-9]{20}$/),
      enforceNonce: true,
    }));
    expect(repo.completeReminderOccurrence).toHaveBeenCalledWith({
      reminderId: "r_1", channelId: "channel", messageId: "delivered-message",
      outcome: "succeeded", executionId: null, nextScheduledFor: undefined,
    });
  });

  it("advances a recurring reminder and returns its next durable wakeup", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-05T12:00:00Z") });
    const repo = deliveryRepo({ recurring: true });
    const send = vi.fn(async (payload) => ({ id: "delivered-message", channelId: "channel", payload }));
    const runner = createReminderDeliveryRunner({ client: discordClient({ canView: true, send }) as never, config: { maxReplyChars: 1800 } as never, repo: repo as never });

    const wakeup = await runner.deliver("r_1");

    expect(repo.completeReminderOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      reminderId: "r_1",
      nextScheduledFor: new Date("2026-08-06T09:00:00Z"),
    }));
    expect(wakeup).toEqual({ reminderId: "r_1", scheduledFor: new Date("2026-08-06T09:00:00Z"), occurrenceSequence: 1 });
  });

  it("runs agent schedules through the scheduled execution adapter before committing delivery", async () => {
    const repo = deliveryRepo({ deliveryKind: "agent" });
    const send = vi.fn();
    const delivered = { id: "agent-result", channelId: "channel" };
    const scheduledAgent = { execute: vi.fn(async () => ({
      message: delivered,
      outcome: "partial" as const,
      executionId: "scheduled-request-execution:r_1:0",
    })) };
    const runner = createReminderDeliveryRunner({
      client: discordClient({ canView: true, send }) as never,
      config: { maxReplyChars: 1800 } as never,
      repo: repo as never,
      scheduledAgent: scheduledAgent as never,
    });

    await runner.deliver("r_1");

    expect(scheduledAgent.execute).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: "r_1", deliveryKind: "agent" }),
      expect.objectContaining({ send }),
      "User",
    );
    expect(send).not.toHaveBeenCalled();
    expect(repo.completeReminderOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "agent-result",
      outcome: "partial",
      executionId: "scheduled-request-execution:r_1:0",
    }));
  });

  it("notifies once when repeated failed agent runs auto-pause a recurring schedule", async () => {
    const repo = deliveryRepo({ recurring: true, deliveryKind: "agent", autoPaused: true });
    const send = vi.fn(async () => ({ id: "pause-notice", channelId: "channel" }));
    const scheduledAgent = { execute: vi.fn(async () => ({
      message: { id: "failed-result", channelId: "channel" },
      outcome: "failed" as const,
      executionId: "scheduled-request-execution:r_1:0",
    })) };
    const runner = createReminderDeliveryRunner({
      client: discordClient({ canView: true, send }) as never,
      config: { maxReplyChars: 1800 } as never,
      repo: repo as never,
      scheduledAgent: scheduledAgent as never,
    });

    await runner.deliver("r_1");

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("paused schedule `r_1` after 3 failed runs"),
      allowedMentions: { parse: [], users: ["user"], repliedUser: false },
      enforceNonce: true,
    }));
  });

  it("fails terminally instead of leaking into another channel when visibility is lost", async () => {
    const repo = deliveryRepo();
    const send = vi.fn();
    const client = discordClient({ canView: false, send });
    const runner = createReminderDeliveryRunner({ client: client as never, config: { maxReplyChars: 1800 } as never, repo: repo as never });

    await runner.deliver("r_1");

    expect(send).not.toHaveBeenCalled();
    expect(repo.markReminderFailed).toHaveBeenCalledWith({ reminderId: "r_1", errorCode: "requester_cannot_view_channel" });
    expect(repo.releaseReminderDelivery).not.toHaveBeenCalled();
  });
});

function deliveryRepo(input: { recurring?: boolean; deliveryKind?: "notification" | "agent"; autoPaused?: boolean } = {}) {
  const reminder = {
    reminderId: "r_1",
    requestKey: "key",
    guildId: "guild",
    channelId: "channel",
    requesterId: "user",
    sourceMessageId: "source",
    reminderText: "check the oven",
    deliveryKind: input.deliveryKind ?? "notification",
    timezone: "UTC",
    scheduledFor: new Date("2026-08-05T09:00:00Z"),
    recurrence: input.recurring ? { frequency: "daily" as const, interval: 1, localTime: "09:00", anchorDate: "2026-08-05" } : null,
    occurrenceSequence: 0,
    status: "delivering",
    deliveryAttempts: 1,
    claimedAt: new Date(),
    deliveredAt: null,
    cancelledAt: null,
    pausedAt: null,
    deliveryChannelId: null,
    deliveryMessageId: null,
    lastErrorCode: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunExecutionId: null,
    consecutiveFailures: 0,
    autoPausedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    claimReminderForDelivery: vi.fn(async () => reminder),
    completeReminderOccurrence: vi.fn(async (delivered: { nextScheduledFor?: Date }) => delivered.nextScheduledFor
      ? {
          ...reminder,
          status: input.autoPaused ? "paused" : "scheduled",
          scheduledFor: delivered.nextScheduledFor,
          occurrenceSequence: 1,
          autoPausedAt: input.autoPaused ? new Date() : null,
          consecutiveFailures: input.autoPaused ? 3 : 0,
        }
      : { ...reminder, status: "delivered" }),
    markReminderFailed: vi.fn(async () => true),
    releaseReminderDelivery: vi.fn(async () => true),
    listDueReminderWakeups: vi.fn(async () => []),
  };
}

function discordClient(input: { canView: boolean; send: (payload: unknown) => Promise<unknown> }) {
  const guild = { members: { fetch: vi.fn(async () => ({ id: "user", displayName: "User", user: { username: "user" } })) } };
  const channel = {
    guild,
    guildId: "guild",
    isTextBased: () => true,
    isDMBased: () => false,
    isThread: () => false,
    permissionsFor: () => ({ has: () => input.canView }),
    send: input.send,
  };
  return { isReady: () => true, channels: { fetch: vi.fn(async () => channel) } };
}
