import { describe, expect, it, vi } from "vitest";
import { listDiscordBugMarkers } from "../../src/tools/discordBugTools.js";

describe("listDiscordBugMarkers", () => {
  it("lists only repository-provided requester-visible markers with prompt context", async () => {
    const listMarkers = vi.fn(async () => [{
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "reply-1",
      userId: "user-1",
      markedAt: new Date("2026-01-02T00:00:00Z"),
      messageAuthorId: "bot-1",
      messageAuthorUsername: "ai",
      messageAuthorIsBot: true,
      messageContent: "I made up the answer",
      messageCreatedAt: new Date("2026-01-01T00:01:00Z"),
      messageLink: "https://discord.com/channels/guild-1/channel-1/reply-1",
      promptMessageId: "prompt-1",
      promptAuthorId: "user-1",
      promptAuthorUsername: "hunter",
      promptContent: "show the real balance",
      promptCreatedAt: new Date("2026-01-01T00:00:00Z"),
      promptLink: "https://discord.com/channels/guild-1/channel-1/prompt-1"
    }]);
    const ctx = {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      visibleChannelIds: ["channel-1"],
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel-1"]),
        listDiscordBugMarkers: listMarkers,
        auditTool: vi.fn(async () => undefined)
      }
    } as any;

    const result = await listDiscordBugMarkers(ctx);

    expect(listMarkers).toHaveBeenCalledWith({ guildId: "guild-1", userId: "user-1", visibleChannelIds: ["channel-1"], limit: 20 });
    expect(result).toContain("active 🐛 bug markers (1)");
    expect(result).toContain("I made up the answer");
    expect(result).toContain("show the real balance");
    expect(result).toContain("<https://discord.com/channels/guild-1/channel-1/reply-1>");
  });

  it("explains how to populate an empty inbox", async () => {
    const ctx = {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      visibleChannelIds: ["channel-1"],
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel-1"]),
        listDiscordBugMarkers: vi.fn(async () => []),
        auditTool: vi.fn(async () => undefined)
      }
    } as any;

    await expect(listDiscordBugMarkers(ctx)).resolves.toContain("React with 🐛");
  });
});
