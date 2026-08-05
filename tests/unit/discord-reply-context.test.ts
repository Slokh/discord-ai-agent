import { describe, expect, it, vi } from "vitest";
import { discordPromptText, queueIncomingMessageEmbedding } from "../../src/discord/messageIngress.js";
import { resolveDiscordReplyContext } from "../../src/discord/replyContext.js";

describe("Discord forwarded message context", () => {
  it("uses a forwarded snapshot as authoritative reply context", async () => {
    const snapshot = {
      id: "source-message",
      guildId: "guild-a",
      channelId: "source-channel",
      author: { id: "bot-a", username: "ai", globalName: "AI", bot: true },
      member: null,
      content: "The forwarded answer and its details.",
      embeds: [{
        title: "Linked context",
        description: "A Discord preview",
        provider: { name: "Example" },
        url: "https://example.test/story#discussion",
      }],
      attachments: new Map(),
      reactions: {
        cache: new Map([[
          "party",
          {
            emoji: { id: "101", name: "party", animated: false },
            count: 2,
            me: false,
          },
        ]]),
      },
      createdAt: new Date("2026-07-17T20:00:00Z"),
      url: "https://discord.com/channels/guild-a/source-channel/source-message",
      reference: null,
    };
    const message = {
      messageSnapshots: new Map([[snapshot.id, snapshot]]),
    };
    const repo = { recordTraceEvent: vi.fn(async () => undefined) };
    const requestLogger = { info: vi.fn(), warn: vi.fn() };

    const context = await resolveDiscordReplyContext({
      repo: repo as any,
      message: message as any,
      visibleChannelIds: ["current-channel"],
      requestLogger: requestLogger as any,
    });

    expect(context).toEqual(expect.objectContaining({
      messageId: "source-message",
      rootMessageId: "source-message",
      authorId: "bot-a",
      content: "The forwarded answer and its details.",
      forwarded: true,
      embeds: [{
        title: "Linked context",
        description: "A Discord preview",
        providerName: "Example",
        url: "https://example.test/story",
      }],
      reactionSummaries: ["<:party:101> ×2"],
    }));
    expect(context?.chain).toHaveLength(1);
  });

  it("records a deleted reply parent as expected unavailable context", async () => {
    const repo = { recordTraceEvent: vi.fn(async () => undefined) };
    const requestLogger = { info: vi.fn(), warn: vi.fn() };
    const message = {
      id: "current-message",
      channelId: "current-channel",
      reference: { messageId: "deleted-message", channelId: "current-channel" },
      fetchReference: vi.fn(async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); }),
      messageSnapshots: new Map(),
    };

    await expect(resolveDiscordReplyContext({
      repo: repo as any,
      message: message as any,
      visibleChannelIds: ["current-channel"],
      requestLogger: requestLogger as any,
    })).resolves.toBeUndefined();

    expect(requestLogger.warn).not.toHaveBeenCalled();
    expect(requestLogger.info).toHaveBeenCalled();
  });

  it("creates useful prompts for Discord messages that have context but no text", () => {
    const forwarded = {
      content: "",
      reference: { messageId: "source-message" },
      messageSnapshots: new Map([["source-message", { id: "source-message", channelId: "source-channel" }]]),
    };

    expect(discordPromptText(forwarded as any, "bot-a", [])).toContain("forwarded message");
    expect(discordPromptText({ ...forwarded, content: "<@bot-a> explain this" } as any, "bot-a", []))
      .toBe("explain this");
    expect(discordPromptText({ content: "", reference: null, messageSnapshots: new Map() } as any, "bot-a", [], 1))
      .toContain("attached content");
    expect(discordPromptText({ content: "", reference: null, messageSnapshots: new Map() } as any, "bot-a", [], 0, 1))
      .toContain("linked preview context");
  });

  it("queues an embed-only member message for indexing", async () => {
    const enqueueMessageEmbedding = vi.fn(async () => "job-1");
    queueIncomingMessageEmbedding(
      { jobs: { enqueueMessageEmbedding } as any },
      {
        id: "message-1",
        channelId: "channel-1",
        content: "",
        embeds: [{ title: "Linked page", url: "https://example.test/page" }],
        author: { id: "user-1", bot: false },
        createdTimestamp: Date.now(),
      } as any,
      "bot-a",
      "message_create",
    );

    await vi.waitFor(() => expect(enqueueMessageEmbedding).toHaveBeenCalledWith(
      "message-1",
      expect.objectContaining({ priority: expect.any(Number) }),
    ));
  });
});
