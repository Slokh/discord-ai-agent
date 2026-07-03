import { describe, expect, it, vi } from "vitest";
import { isExcludedChannelId, persistDiscordMessage, reactionSummariesFromMessage } from "../../src/discord/messagePersistence.js";

describe("reactionSummariesFromMessage", () => {
  it("extracts stable reaction metadata without user lists", () => {
    const message = {
      reactions: {
        cache: new Map([
          [
            "custom",
            {
              emoji: { id: "emoji-1", name: "party", animated: true },
              count: 3,
              me: false,
              countDetails: { normal: 2, burst: 1 }
            }
          ],
          [
            "unicode",
            {
              emoji: { id: null, name: "👍", animated: false },
              count: 5,
              me: true
            }
          ]
        ])
      }
    };

    expect(reactionSummariesFromMessage(message as any)).toEqual([
      {
        emojiId: "emoji-1",
        emojiName: "party",
        animated: true,
        count: 3,
        me: false,
        countDetails: { normal: 2, burst: 1 }
      },
      {
        emojiId: null,
        emojiName: "👍",
        animated: false,
        count: 5,
        me: true,
        countDetails: null
      }
    ]);
  });

  it("returns an empty list when reactions are not cached", () => {
    expect(reactionSummariesFromMessage({ reactions: {} } as any)).toEqual([]);
  });
});

describe("isExcludedChannelId", () => {
  it("matches configured excluded channel IDs and ignores empty IDs", () => {
    const excluded = new Set(["excluded-channel"]);
    expect(isExcludedChannelId("excluded-channel", excluded)).toBe(true);
    expect(isExcludedChannelId("other", excluded)).toBe(false);
    expect(isExcludedChannelId(null, excluded)).toBe(false);
    expect(isExcludedChannelId(undefined, excluded)).toBe(false);
  });
});

describe("persistDiscordMessage exclusion", () => {
  it("marks excluded channels as excluded and skips storing the message", async () => {
    const repo = {
      upsertGuild: vi.fn(async () => undefined),
      upsertChannel: vi.fn(async () => undefined),
      setChannelExcluded: vi.fn(async () => undefined),
      upsertMessage: vi.fn(async () => undefined)
    };
    const message = {
      inGuild: () => true,
      partial: false,
      guildId: "guild-1",
      guild: { id: "guild-1", name: "Guild" },
      channel: { id: "excluded-channel", parentId: null, name: "excluded", type: 0, isThread: () => false },
      channelId: "excluded-channel",
      author: { id: "user-1", username: "user", globalName: "User", bot: false },
      content: "trivia answer",
      createdAt: new Date(0),
      editedAt: null,
      type: 0,
      pinned: false,
      reference: null,
      member: null,
      attachments: { values: () => [] },
      reactions: { cache: new Map() }
    };

    await persistDiscordMessage(repo as any, message as any, {
      excludedChannelIds: new Set(["excluded-channel"])
    });

    expect(repo.setChannelExcluded).toHaveBeenCalledWith(expect.objectContaining({ channelId: "excluded-channel", excluded: true }));
    expect(repo.upsertMessage).not.toHaveBeenCalled();
  });

  it("stores messages normally for non-excluded channels", async () => {
    const repo = {
      upsertGuild: vi.fn(async () => undefined),
      upsertChannel: vi.fn(async () => undefined),
      setChannelExcluded: vi.fn(async () => undefined),
      upsertMessage: vi.fn(async () => undefined)
    };
    const message = {
      inGuild: () => true,
      partial: false,
      guildId: "guild-1",
      guild: { id: "guild-1", name: "Guild" },
      channel: { id: "general", parentId: null, name: "general", type: 0, isThread: () => false },
      channelId: "general",
      author: { id: "user-1", username: "user", globalName: "User", bot: false },
      content: "hello",
      createdAt: new Date(0),
      editedAt: null,
      type: 0,
      pinned: false,
      reference: null,
      member: null,
      attachments: { values: () => [] },
      reactions: { cache: new Map() }
    };

    await persistDiscordMessage(repo as any, message as any, {
      excludedChannelIds: new Set(["excluded-channel"])
    });

    expect(repo.setChannelExcluded).not.toHaveBeenCalled();
    expect(repo.upsertMessage).toHaveBeenCalledTimes(1);
  });
});
