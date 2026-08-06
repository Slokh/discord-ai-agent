import { describe, expect, it, vi } from "vitest";
import {
  createScheduledAgentRequestRunner,
  scheduledAgentOccurrenceIdentity,
} from "../../src/reminders/scheduledAgentExecution.js";
import { agentExecutionPolicy, discordAgentThreadKey } from "../../src/discord/agentExecutionPolicy.js";

describe("scheduled agent execution", () => {
  it("creates one idempotent status message and enters the canonical agent path as scheduled", async () => {
    const statusMessage = { id: "status", channelId: "channel", url: "https://discord.test/status" };
    const finalMessage = { id: "final", channelId: "channel", url: "https://discord.test/final" };
    const send = vi.fn(async () => statusMessage);
    const executeAgent = vi.fn(async () => ({ status: "succeeded" as const, message: finalMessage }));
    const runner = createScheduledAgentRequestRunner({
      client: {} as never,
      config: { maxReplyChars: 1800, discord: { loadingReaction: "⏳" } } as never,
      repo: {} as never,
      openRouter: {} as never,
      deliveryObligations: { getByExecutionId: vi.fn(async () => undefined) } as never,
      executeAgent: executeAgent as never,
    });

    await expect(runner.execute(reminder(), { send } as never, "Member"))
      .resolves.toBe(finalMessage);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: "<@user> running your scheduled request…",
      allowedMentions: { parse: [], users: ["user"], repliedUser: false },
      enforceNonce: true,
    }));
    expect(executeAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      statusMessage,
      expect.anything(),
      expect.objectContaining({
        requestId: "scheduled-request:r_1:3",
        agentSessionId: "scheduled-request-session:r_1",
        agentExecutionId: "scheduled-request-execution:r_1:3",
        requestKind: "scheduled",
        userId: "user",
        userDisplayName: "Member",
        text: "summarize yesterday",
      }),
    );
  });

  it("recovers an already delivered occurrence without rerunning the model", async () => {
    const executeAgent = vi.fn();
    const send = vi.fn();
    const runner = createScheduledAgentRequestRunner({
      client: {} as never,
      config: { maxReplyChars: 1800, discord: { loadingReaction: "⏳" } } as never,
      repo: {} as never,
      openRouter: {} as never,
      deliveryObligations: {
        getByExecutionId: vi.fn(async () => ({
          state: "delivered",
          statusChannelId: "channel",
          statusMessageId: "delivered",
        })),
      } as never,
      executeAgent: executeAgent as never,
    });

    await expect(runner.execute(reminder(), { send } as never, "Member"))
      .resolves.toEqual(expect.objectContaining({ id: "delivered", channelId: "channel" }));
    expect(send).not.toHaveBeenCalled();
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("derives stable identities from the schedule occurrence", () => {
    expect(scheduledAgentOccurrenceIdentity({ reminderId: "r_1", occurrenceSequence: 3 })).toEqual({
      requestId: "scheduled-request:r_1:3",
      sessionId: "scheduled-request-session:r_1",
      executionId: "scheduled-request-execution:r_1:3",
      deliveryKey: "scheduled-request:r_1:3",
    });
  });

  it("separates scheduled traffic and denies it mutation authority", () => {
    expect(agentExecutionPolicy("scheduled")).toEqual({
      qualityCohort: "scheduled",
      sessionKind: "scheduled_request",
      mutationAuthorizedByCurrentInput: false,
      readOnlyExecution: true,
      loadAmbientConversationMemory: false,
    });
    expect(agentExecutionPolicy("message")).toEqual(expect.objectContaining({
      qualityCohort: "member",
      mutationAuthorizedByCurrentInput: true,
      readOnlyExecution: false,
      loadAmbientConversationMemory: true,
    }));
    expect(discordAgentThreadKey({
      requestKind: "scheduled",
      guildId: "guild",
      channelId: "channel",
      requesterId: "user",
      agentSessionId: "schedule-session",
      requestId: "occurrence",
    })).toBe("discord-scheduled:guild:user:schedule-session");
  });
});

function reminder() {
  return {
    reminderId: "r_1",
    requestKey: "key",
    guildId: "guild",
    channelId: "channel",
    requesterId: "user",
    sourceMessageId: "source",
    reminderText: "summarize yesterday",
    deliveryKind: "agent" as const,
    timezone: "UTC",
    scheduledFor: new Date("2026-08-06T09:00:00Z"),
    recurrence: null,
    occurrenceSequence: 3,
    status: "delivering" as const,
    deliveryAttempts: 1,
    claimedAt: new Date(),
    deliveredAt: null,
    cancelledAt: null,
    pausedAt: null,
    deliveryChannelId: null,
    deliveryMessageId: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
