import { describe, expect, it, vi } from "vitest";
import { handleDiscordImprovementReaction } from "../../src/discord/improvementReaction.js";

vi.mock("../../src/discord/messagePersistence.js", () => ({
  persistDiscordMessage: vi.fn(async () => undefined),
}));

describe("Discord improvement reactions", () => {
  it("records reports on assistant responses", async () => {
    const execution = {
      executionId: "execution-a",
      metadata: { appRevision: "revision-a" },
    };
    const repo = {
      findAgentRuntimeChatExecutionByTraceId: vi.fn(async () => execution),
      recordImprovementSignal: vi.fn(async (input: Record<string, unknown>) => ({
        case: { caseId: "case-a" },
        signal: { signalId: "signal-a" },
        input,
      })),
      ensureImprovementReporterConversation: vi.fn(async () => undefined),
    };
    const message = {
      id: "reply-message-a",
      guildId: "guild-a",
      channelId: "channel-a",
      partial: false,
      author: { id: "bot-user", bot: true },
      inGuild: () => true,
    };

    const handled = await handleDiscordImprovementReaction(
      {
        config: { discord: { guildId: "guild-a" }, appRevision: "current-revision" } as never,
        repo: repo as never,
        botUserId: "bot-user",
      },
      { emoji: { id: null, name: "🐛" }, partial: false, message } as never,
      { id: "reporter-a", bot: false } as never,
      true,
    );

    expect(handled).toBe(true);
    expect(repo.findAgentRuntimeChatExecutionByTraceId).toHaveBeenCalledWith("reply-message-a");
    expect(repo.recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "reply-message-a",
      executionId: "execution-a",
      appRevision: "revision-a",
      summary: "A member reported a Discord assistant interaction",
      owningDomain: "agent-replies",
    }));
  });

  it("ignores reports on user-authored messages before looking up an execution", async () => {
    const repo = {
      findAgentRuntimeChatExecutionByTraceId: vi.fn(),
      recordImprovementSignal: vi.fn(),
      withdrawImprovementSignal: vi.fn(),
      ensureImprovementReporterConversation: vi.fn(),
    };
    const message = {
      id: "prompt-message-a",
      guildId: "guild-a",
      channelId: "channel-a",
      partial: false,
      author: { id: "member-author", bot: false },
      inGuild: () => true,
    };

    const handled = await handleDiscordImprovementReaction(
      {
        config: { discord: { guildId: "guild-a" }, appRevision: "current-revision" } as never,
        repo: repo as never,
        botUserId: "bot-user",
      },
      { emoji: { id: null, name: "🐛" }, partial: false, message } as never,
      { id: "reporter-a", bot: false } as never,
      true,
    );

    expect(handled).toBe(false);
    expect(repo.findAgentRuntimeChatExecutionByTraceId).not.toHaveBeenCalled();
    expect(repo.recordImprovementSignal).not.toHaveBeenCalled();
    expect(repo.ensureImprovementReporterConversation).not.toHaveBeenCalled();
  });
});
