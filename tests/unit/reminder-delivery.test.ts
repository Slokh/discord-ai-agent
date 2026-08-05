import { describe, expect, it, vi } from "vitest";
import { createReminderDeliveryRunner } from "../../src/reminders/reminderDelivery.js";

describe("reminder delivery", () => {
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
    expect(repo.markReminderDelivered).toHaveBeenCalledWith({ reminderId: "r_1", channelId: "channel", messageId: "delivered-message" });
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

function deliveryRepo() {
  return {
    claimReminderForDelivery: vi.fn(async () => ({
      reminderId: "r_1",
      requestKey: "key",
      guildId: "guild",
      channelId: "channel",
      requesterId: "user",
      sourceMessageId: "source",
      reminderText: "check the oven",
      timezone: "UTC",
      scheduledFor: new Date("2026-08-05T12:00:00Z"),
      status: "delivering",
      deliveryAttempts: 1,
      claimedAt: new Date(),
      deliveredAt: null,
      cancelledAt: null,
      deliveryChannelId: null,
      deliveryMessageId: null,
      lastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    markReminderDelivered: vi.fn(async () => true),
    markReminderFailed: vi.fn(async () => true),
    releaseReminderDelivery: vi.fn(async () => true),
    listDueReminderIds: vi.fn(async () => []),
  };
}

function discordClient(input: { canView: boolean; send: (payload: unknown) => Promise<unknown> }) {
  const guild = { members: { fetch: vi.fn(async () => ({ id: "user" })) } };
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
