import { describe, expect, it, vi } from "vitest";
import {
  clearDiscordBugMarkersForReaction,
  DISCORD_BUG_MARKER_EMOJI,
  handleDiscordBugMarkerReaction,
  isDiscordBugMarkerReaction
} from "../../src/discord/bugMarkerReaction.js";

describe("Discord bug marker reactions", () => {
  it("recognizes only the Unicode bug emoji", () => {
    expect(isDiscordBugMarkerReaction({ id: null, name: DISCORD_BUG_MARKER_EMOJI })).toBe(true);
    expect(isDiscordBugMarkerReaction({ id: "custom", name: "bug" })).toBe(false);
    expect(isDiscordBugMarkerReaction({ id: null, name: "❌" })).toBe(false);
  });

  it("persists and removes requester-scoped markers", async () => {
    const repo = fakeRepo();
    const reaction = fakeReaction();
    const input = { config: { discord: { guildId: "guild-1" } }, repo } as any;

    await expect(handleDiscordBugMarkerReaction(input, reaction as any, { id: "user-1", bot: false } as any, true)).resolves.toBe(true);
    expect(repo.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1", authorIsBot: true }));
    expect(repo.setDiscordBugMarker).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "user-1",
      present: true
    });

    await expect(handleDiscordBugMarkerReaction(input, reaction as any, { id: "user-1", bot: false } as any, false)).resolves.toBe(true);
    expect(repo.setDiscordBugMarker).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "user-1", present: false }));
  });

  it("clears all stored markers when Discord removes the bug reaction", async () => {
    const repo = fakeRepo();
    await expect(clearDiscordBugMarkersForReaction(
      { config: { discord: { guildId: "guild-1" } }, repo } as any,
      fakeReaction() as any
    )).resolves.toBe(2);
    expect(repo.clearDiscordBugMarkersForMessage).toHaveBeenCalledWith({ guildId: "guild-1", messageId: "message-1" });
  });

  it("removes the last marker without fetching a reaction that no longer exists", async () => {
    const repo = fakeRepo();
    const reaction = {
      ...fakeReaction(),
      partial: true,
      fetch: vi.fn(async () => { throw new Error("Unknown Emoji"); })
    };

    await expect(handleDiscordBugMarkerReaction(
      { config: { discord: { guildId: "guild-1" } }, repo } as any,
      reaction as any,
      { id: "user-1", bot: false } as any,
      false
    )).resolves.toBe(true);
    expect(reaction.fetch).not.toHaveBeenCalled();
    expect(repo.setDiscordBugMarker).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", present: false }));
  });

  it("ignores bot reactors and other guilds", async () => {
    const repo = fakeRepo();
    const input = { config: { discord: { guildId: "guild-1" } }, repo } as any;
    await expect(handleDiscordBugMarkerReaction(input, fakeReaction() as any, { id: "bot", bot: true } as any, true)).resolves.toBe(false);
    await expect(handleDiscordBugMarkerReaction(input, fakeReaction("guild-2") as any, { id: "user", bot: false } as any, true)).resolves.toBe(false);
    expect(repo.setDiscordBugMarker).not.toHaveBeenCalled();
  });
});

function fakeRepo() {
  return {
    upsertGuild: vi.fn(async () => undefined),
    upsertChannel: vi.fn(async () => undefined),
    upsertMessage: vi.fn(async () => undefined),
    setDiscordBugMarker: vi.fn(async () => true),
    clearDiscordBugMarkersForMessage: vi.fn(async () => 2),
    recordTraceEvent: vi.fn(async () => undefined)
  };
}

function fakeReaction(guildId = "guild-1") {
  const message = {
    id: "message-1",
    partial: false,
    inGuild: () => true,
    guildId,
    channelId: "channel-1",
    guild: { id: guildId, name: "Guild" },
    channel: { id: "channel-1", name: "general", type: 0, parentId: null, isThread: () => false },
    author: { id: "bot-1", username: "ai", globalName: "AI", bot: true },
    content: "bad answer",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    editedAt: null,
    type: 0,
    system: false,
    pinned: false,
    url: `https://discord.com/channels/${guildId}/channel-1/message-1`,
    reactions: { cache: new Map() },
    attachments: new Map()
  };
  return {
    partial: false,
    emoji: { id: null, name: DISCORD_BUG_MARKER_EMOJI, animated: false },
    message
  };
}
