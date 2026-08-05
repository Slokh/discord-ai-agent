import { describe, expect, it, vi } from "vitest";
import { handleDiscordImprovementReaction } from "../../src/discord/improvementReaction.js";

vi.mock("../../src/discord/messagePersistence.js", () => ({
  persistDiscordMessage: vi.fn(async () => undefined),
}));

describe("Discord improvement reactions", () => {
  it("links prompt- and reply-side reports to one canonical interaction fingerprint", async () => {
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
      id: "prompt-message-a",
      guildId: "guild-a",
      channelId: "channel-a",
      partial: false,
      author: { id: "member-author", bot: false },
      inGuild: () => true,
    };

    await handleDiscordImprovementReaction(
      {
        config: { discord: { guildId: "guild-a" }, appRevision: "current-revision" } as never,
        repo: repo as never,
        botUserId: "bot-user",
      },
      { emoji: { id: null, name: "🐛" }, partial: false, message } as never,
      { id: "reporter-a", bot: false } as never,
      true,
    );

    expect(repo.findAgentRuntimeChatExecutionByTraceId).toHaveBeenCalledWith("prompt-message-a");
    expect(repo.recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "prompt-message-a",
      executionId: "execution-a",
      appRevision: "revision-a",
      summary: "A member reported a Discord assistant interaction",
      owningDomain: "agent-replies",
    }));

    await handleDiscordImprovementReaction(
      {
        config: { discord: { guildId: "guild-a" }, appRevision: "current-revision" } as never,
        repo: repo as never,
        botUserId: "bot-user",
      },
      {
        emoji: { id: null, name: "🐛" },
        partial: false,
        message: { ...message, id: "reply-message-a", author: { id: "bot-user", bot: true } },
      } as never,
      { id: "reporter-b", bot: false } as never,
      true,
    );

    const promptSignal = repo.recordImprovementSignal.mock.calls[0]![0];
    const replySignal = repo.recordImprovementSignal.mock.calls[1]![0];
    expect(promptSignal.fingerprint).toBe(replySignal.fingerprint);
  });
});
