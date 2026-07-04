import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { persistDiscordMessage, reactionSummariesFromMessage } from "../../src/discord/messagePersistence.js";

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

describe("persistDiscordMessage", () => {
  function fakeMessage(channelId: string) {
    return {
      id: "message-1",
      inGuild: () => true,
      partial: false,
      guild: { id: "guild-1", name: "Guild" },
      channel: { id: channelId, isThread: () => false },
      author: { id: "user-1", username: "user", globalName: "User", bot: false },
      content: "hello",
      createdAt: new Date(),
      editedAt: null,
      type: 0,
      pinned: false,
      reference: null,
      member: null,
      attachments: new Collection()
    };
  }

  it("skips persistence for excluded channels", async () => {
    const repo = {
      isChannelExcluded: vi.fn(async () => true),
      upsertGuild: vi.fn(async () => undefined),
      upsertChannel: vi.fn(async () => undefined),
      upsertMessage: vi.fn(async () => undefined)
    };

    await persistDiscordMessage(repo as any, fakeMessage("excluded-1") as any);

    expect(repo.isChannelExcluded).toHaveBeenCalledWith("excluded-1");
    expect(repo.upsertGuild).not.toHaveBeenCalled();
    expect(repo.upsertChannel).not.toHaveBeenCalled();
    expect(repo.upsertMessage).not.toHaveBeenCalled();
  });

  it("persists messages for non-excluded channels", async () => {
    const repo = {
      isChannelExcluded: vi.fn(async () => false),
      upsertGuild: vi.fn(async () => undefined),
      upsertChannel: vi.fn(async () => undefined),
      upsertMessage: vi.fn(async () => undefined)
    };

    await persistDiscordMessage(repo as any, fakeMessage("included-1") as any);

    expect(repo.isChannelExcluded).toHaveBeenCalledWith("included-1");
    expect(repo.upsertGuild).toHaveBeenCalledWith(expect.objectContaining({ id: "guild-1" }));
    expect(repo.upsertChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "included-1" }));
    expect(repo.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1", channelId: "included-1" }));
  });
});
