import { describe, expect, it, vi } from "vitest";
import { discordPromptText } from "../../src/discord/messageIngress.js";
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
      attachments: new Map(),
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
    }));
    expect(context?.chain).toHaveLength(1);
    expect(repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "discord.reply_context.resolved",
      metadata: expect.objectContaining({ referencedMessageId: "source-message" }),
    }));
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
  });
});
