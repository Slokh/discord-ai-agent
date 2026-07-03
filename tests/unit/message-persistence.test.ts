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

describe("persistDiscordMessage excluded channel guard", () => {
  it("skips persisting messages from permanently-excluded channels", async () => {
    const repo = {
      upsertGuild: vi.fn(async () => undefined),
      upsertChannel: vi.fn(async () => undefined),
      upsertMessage: vi.fn(async () => undefined)
    };
    const message = {
      inGuild: () => true,
      partial: false,
      guild: { id: "guild-1", name: "Guild" },
      channel: { id: "1172353113471074314" },
      author: { id: "user-1", username: "user", globalName: "User", bot: false },
      content: "trivia noise",
      createdAt: new Date(),
      editedAt: null,
      type: 0,
      pinned: false,
      reference: null,
      member: null,
      attachments: { values: () => [] },
      reactions: { cache: new Map() }
    };

    await persistDiscordMessage(repo as any, message as any);

    expect(repo.upsertGuild).not.toHaveBeenCalled();
    expect(repo.upsertChannel).not.toHaveBeenCalled();
    expect(repo.upsertMessage).not.toHaveBeenCalled();
  });
});
