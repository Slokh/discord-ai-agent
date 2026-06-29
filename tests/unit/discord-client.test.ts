import { describe, expect, it, vi } from "vitest";
import {
  deletedMessageIdsForConfiguredGuild,
  discordChannelThreadKey,
  explicitChannelMentionIds,
  explicitRoleMentionIds,
  explicitUserMentionIds,
  hasExplicitBotAddress,
  hasExplicitBotMention,
  isSelfMessage,
  persistReactionMessage,
  sendChunkedReply,
  shouldProcessGuildEvent,
  stripBotAddress
} from "../../src/discord/client.js";

describe("isSelfMessage", () => {
  it("detects messages authored by the current bot user", () => {
    expect(isSelfMessage({ author: { id: "bot" } } as any, "bot")).toBe(true);
    expect(isSelfMessage({ author: { id: "friend" } } as any, "bot")).toBe(false);
  });

  it("does not skip messages when the bot user id is not known yet", () => {
    expect(isSelfMessage({ author: { id: "bot" } } as any, undefined)).toBe(false);
  });
});

describe("hasExplicitBotMention", () => {
  it("requires a literal bot mention in message content", () => {
    expect(hasExplicitBotMention("<@bot> hello", "bot")).toBe(true);
    expect(hasExplicitBotMention("<@!bot> hello", "bot")).toBe(true);
    expect(hasExplicitBotMention("replying without a literal mention", "bot")).toBe(false);
    expect(hasExplicitBotMention("<@someone-else> hello", "bot")).toBe(false);
  });
});

describe("hasExplicitBotAddress", () => {
  it("accepts the bot user mention or configured bot role mentions", () => {
    expect(hasExplicitBotAddress("<@123> hello", "123", ["456"])).toBe(true);
    expect(hasExplicitBotAddress("<@&456> hello", "123", ["456"])).toBe(true);
    expect(hasExplicitBotAddress("<@&789> hello", "123", ["456"])).toBe(false);
  });

  it("strips bot user and role mentions from the prompt text", () => {
    expect(stripBotAddress("<@123> hello", "123", ["456"])).toBe("hello");
    expect(stripBotAddress("<@&456> hello", "123", ["456"])).toBe("hello");
    expect(stripBotAddress("<@&789> hello", "123", ["456"])).toBe("<@&789> hello");
  });
});

describe("explicit mention parsing", () => {
  it("extracts content user mentions in order, deduped, excluding the bot", () => {
    expect(explicitUserMentionIds("<@111> hi <@!222> and <@111> cc <@333>", "222")).toEqual(["111", "333"]);
  });

  it("extracts content role mentions in order and deduped", () => {
    expect(explicitRoleMentionIds("<@&111> hi <@&222> and <@&111>")).toEqual(["111", "222"]);
  });

  it("extracts content channel mentions without needing Discord mention cache state", () => {
    expect(explicitChannelMentionIds("<#123> pizza <#456> <#123>")).toEqual(["123", "456"]);
  });
});

describe("single-guild event filters", () => {
  it("processes events only for the configured guild", () => {
    expect(shouldProcessGuildEvent("guild-a", "guild-a")).toBe(true);
    expect(shouldProcessGuildEvent("guild-a", "guild-b")).toBe(false);
    expect(shouldProcessGuildEvent("guild-a", null)).toBe(false);
  });

  it("keeps bulk delete tombstones scoped to the configured guild", () => {
    expect(
      deletedMessageIdsForConfiguredGuild(
        [
          { id: "message-a", guildId: "guild-a" },
          { id: "message-b", guildId: "guild-b" },
          { id: "message-c", guildId: null }
        ],
        "guild-a"
      )
    ).toEqual(["message-a"]);
  });
});

describe("discordChannelThreadKey", () => {
  it("keys persistent conversation memory by Discord channel", () => {
    expect(discordChannelThreadKey("guild-a", "channel-b")).toBe("discord:guild-a:channel-b");
  });
});

describe("persistReactionMessage", () => {
  it("persists reaction metadata refreshes for the configured guild", async () => {
    const repo = fakeRepo();
    const message = fakeGuildMessage("guild-a");

    await persistReactionMessage({ config: { discord: { guildId: "guild-a" } } as any, repo: repo as any }, message as any);

    expect(repo.upsertGuild).toHaveBeenCalledWith({ id: "guild-a", name: "Test Guild", raw: { id: "guild-a", name: "Test Guild" } });
    expect(repo.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "message-1",
        guildId: "guild-a",
        raw: expect.objectContaining({
          reactions: [
            expect.objectContaining({
              emojiName: "party",
              count: 2
            })
          ]
        })
      })
    );
  });

  it("skips reaction metadata refreshes from other guilds", async () => {
    const repo = fakeRepo();

    await persistReactionMessage(
      { config: { discord: { guildId: "guild-a" } } as any, repo: repo as any },
      fakeGuildMessage("guild-b") as any
    );

    expect(repo.upsertMessage).not.toHaveBeenCalled();
  });
});

function fakeRepo() {
  return {
    upsertGuild: vi.fn(async () => undefined),
    upsertChannel: vi.fn(async () => undefined),
    upsertUser: vi.fn(async () => undefined),
    upsertMessage: vi.fn(async () => undefined),
    isUserPrivacyDeleted: vi.fn(async () => false)
  };
}

function fakeGuildMessage(guildId: string) {
  return {
    id: "message-1",
    partial: false,
    inGuild: () => true,
    guildId,
    guild: { id: guildId, name: "Test Guild" },
    channel: {
      id: "channel-1",
      name: "general",
      type: 0,
      parentId: null,
      isThread: () => false
    },
    author: {
      id: "author-1",
      username: "alice",
      globalName: "Alice",
      bot: false
    },
    content: "hello",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    editedAt: null,
    type: 0,
    system: false,
    pinned: false,
    url: `https://discord.com/channels/${guildId}/channel-1/message-1`,
    reactions: {
      cache: new Map([
        [
          "party",
          {
            emoji: { id: null, name: "party", animated: false },
            count: 2,
            me: false
          }
        ]
      ])
    },
    attachments: new Map()
  };
}

describe("sendChunkedReply", () => {
  function makeThinking() {
    return {
      edit: vi.fn().mockResolvedValue({ id: "msg-1" })
    } as any;
  }

  function makeSourceMessage(sends: string[]) {
    return {
      channel: {
        send: vi.fn().mockImplementation(async (content: string) => {
          sends.push(content);
          return { id: `msg-${sends.length + 1}` };
        })
      }
    } as any;
  }

  it("edits the thinking message with a single chunk and no follow-ups", async () => {
    const thinking = makeThinking();
    const sourceMessage = makeSourceMessage([]);
    const result = await sendChunkedReply(thinking, sourceMessage, ["short reply"], undefined);
    expect(thinking.edit).toHaveBeenCalledTimes(1);
    expect(thinking.edit).toHaveBeenCalledWith({ content: "short reply", files: undefined });
    expect(sourceMessage.channel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "msg-1" });
  });

  it("edits the first chunk then sends remaining chunks as follow-up messages", async () => {
    const thinking = makeThinking();
    const sends: string[] = [];
    const sourceMessage = makeSourceMessage(sends);
    const chunks = ["chunk-1", "chunk-2", "chunk-3"];
    const result = await sendChunkedReply(thinking, sourceMessage, chunks, undefined);
    expect(thinking.edit).toHaveBeenCalledTimes(1);
    expect(thinking.edit).toHaveBeenCalledWith({ content: "chunk-1", files: undefined });
    expect(sends).toEqual(["chunk-2", "chunk-3"]);
    expect(result).toEqual({ id: "msg-3" });
  });

  it("attaches files only to the first message", async () => {
    const thinking = makeThinking();
    const sends: string[] = [];
    const sourceMessage = makeSourceMessage(sends);
    const fakeAttachment = { name: "file.png" } as any;
    const result = await sendChunkedReply(thinking, sourceMessage, ["a", "b"], [fakeAttachment]);
    expect(thinking.edit).toHaveBeenCalledWith({ content: "a", files: [fakeAttachment] });
    expect(sends).toEqual(["b"]);
    expect(result).toEqual({ id: "msg-2" });
  });
});
