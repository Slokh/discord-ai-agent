import { describe, expect, it, vi } from "vitest";
import {
  deletedMessageIdsForConfiguredGuild,
  discordChannelThreadKey,
  explicitChannelMentionIds,
  explicitRoleMentionIds,
  explicitUserMentionIds,
  handleUndoCrossReaction,
  hasExplicitBotAddress,
  hasExplicitBotMention,
  isSelfMessage,
  persistReactionMessage,
  resolveBotMentionContext,
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

describe("resolveBotMentionContext", () => {
  it("treats an explicit user mention as addressed", async () => {
    const message = fakeReplyableMessage("<@bot-1> hello", undefined);
    const result = await resolveBotMentionContext(message as any, "bot-1");
    expect(result).toEqual({ addressed: true, kind: "user", botRoleIds: [] });
    expect(message.fetchReference).not.toHaveBeenCalled();
  });

  it("treats a reply to a bot message as addressed without an explicit mention", async () => {
    const message = fakeReplyableMessage("continuing the thread", {
      messageId: "parent-1",
      authorId: "bot-1"
    });
    const result = await resolveBotMentionContext(message as any, "bot-1");
    expect(result).toEqual({ addressed: true, kind: "reply", botRoleIds: [] });
  });

  it("does not treat a reply to another user as addressed", async () => {
    const message = fakeReplyableMessage("replying to a human", {
      messageId: "parent-1",
      authorId: "human-1"
    });
    const result = await resolveBotMentionContext(message as any, "bot-1");
    expect(result).toEqual({ addressed: false, kind: null, botRoleIds: [] });
  });

  it("does not treat a message without a reply as addressed", async () => {
    const message = fakeReplyableMessage("just talking", undefined);
    const result = await resolveBotMentionContext(message as any, "bot-1");
    expect(result).toEqual({ addressed: false, kind: null, botRoleIds: [] });
  });

  it("falls back to not addressed when the reply reference cannot be fetched", async () => {
    const message = fakeReplyableMessage("replying", { messageId: "parent-1", authorId: "bot-1", fetchThrows: true });
    const result = await resolveBotMentionContext(message as any, "bot-1");
    expect(result).toEqual({ addressed: false, kind: null, botRoleIds: [] });
  });
});

function fakeReplyableMessage(
  content: string,
  reference:
    | { messageId: string; authorId: string; fetchThrows?: boolean }
    | undefined
) {
  const fetchReference = vi.fn(async () => {
    if (reference?.fetchThrows) throw new Error("fetch failed");
    if (!reference) throw new Error("no reference");
    return {
      author: { id: reference.authorId },
      inGuild: () => true,
      guildId: "guild-a",
      channelId: "channel-1"
    };
  });
  return {
    id: "message-1",
    content,
    reference: reference ? { messageId: reference.messageId, channelId: "channel-1", guildId: "guild-a" } : undefined,
    fetchReference,
    guild: { id: "guild-a", name: "Test Guild", roles: { fetch: vi.fn(async () => undefined), cache: { filter: () => ({ map: () => [] }) } } }
  };
}

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

describe("handleUndoCrossReaction", () => {
  it("removes a bot reply from memory and deletes the message on ❌", async () => {
    const repo = {
      deleteConversationMessagesByDiscordMessageIds: vi.fn(async () => 2),
      recordTraceEvent: vi.fn(async () => undefined)
    };
    const channel = {
      id: "channel-1",
      messages: {
        delete: vi.fn(async () => undefined)
      }
    };
    const message = fakeGuildBotReplyMessage("guild-a", "bot-1", "reply-1", channel);
    const reaction = fakeReaction({ emoji: "❌", message });
    const client = { user: { id: "bot-1" } } as any;

    const handled = await handleUndoCrossReaction(
      { config: { discord: { guildId: "guild-a" } } as any, repo: repo as any, client } as any,
      client,
      reaction as any,
      { id: "user-1", bot: false } as any
    );

    expect(handled).toBe(true);
    expect(repo.deleteConversationMessagesByDiscordMessageIds).toHaveBeenCalledWith({
      threadKey: "discord:guild-a:channel-1",
      discordMessageIds: ["reply-1"]
    });
    expect(channel.messages.delete).toHaveBeenCalledWith("reply-1");
    expect(repo.recordTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "discord.reply.undone_by_reaction",
        metadata: expect.objectContaining({ replyMessageId: "reply-1", deletedMemoryRows: 2, reactorUserId: "user-1" })
      })
    );
  });

  it("ignores ❌ reactions that the bot itself added", async () => {
    const repo = {
      deleteConversationMessagesByDiscordMessageIds: vi.fn(async () => 1),
      recordTraceEvent: vi.fn(async () => undefined)
    };
    const message = fakeGuildBotReplyMessage("guild-a", "bot-1", "reply-1");
    const reaction = fakeReaction({ emoji: "❌", message });
    const client = { user: { id: "bot-1" } } as any;

    const handled = await handleUndoCrossReaction(
      { config: { discord: { guildId: "guild-a" } } as any, repo: repo as any, client } as any,
      client,
      reaction as any,
      { id: "bot-1", bot: true } as any
    );

    expect(handled).toBe(false);
    expect(repo.deleteConversationMessagesByDiscordMessageIds).not.toHaveBeenCalled();
  });

  it("ignores ❌ reactions on non-bot messages", async () => {
    const repo = {
      deleteConversationMessagesByDiscordMessageIds: vi.fn(async () => 1),
      recordTraceEvent: vi.fn(async () => undefined)
    };
    const message = fakeGuildMessage("guild-a");
    const reaction = fakeReaction({ emoji: "❌", message });
    const client = { user: { id: "bot-1" } } as any;

    const handled = await handleUndoCrossReaction(
      { config: { discord: { guildId: "guild-a" } } as any, repo: repo as any, client } as any,
      client,
      reaction as any,
      { id: "user-1", bot: false } as any
    );

    expect(handled).toBe(false);
    expect(repo.deleteConversationMessagesByDiscordMessageIds).not.toHaveBeenCalled();
  });

  it("ignores reactions that are not ❌", async () => {
    const repo = {
      deleteConversationMessagesByDiscordMessageIds: vi.fn(async () => 1),
      recordTraceEvent: vi.fn(async () => undefined)
    };
    const message = fakeGuildBotReplyMessage("guild-a", "bot-1", "reply-1");
    const reaction = fakeReaction({ emoji: "✅", message });
    const client = { user: { id: "bot-1" } } as any;

    const handled = await handleUndoCrossReaction(
      { config: { discord: { guildId: "guild-a" } } as any, repo: repo as any, client } as any,
      client,
      reaction as any,
      { id: "user-1", bot: false } as any
    );

    expect(handled).toBe(false);
    expect(repo.deleteConversationMessagesByDiscordMessageIds).not.toHaveBeenCalled();
  });

  it("ignores ❌ reactions from other guilds", async () => {
    const repo = {
      deleteConversationMessagesByDiscordMessageIds: vi.fn(async () => 1),
      recordTraceEvent: vi.fn(async () => undefined)
    };
    const message = fakeGuildBotReplyMessage("guild-b", "bot-1", "reply-1");
    const reaction = fakeReaction({ emoji: "❌", message });
    const client = { user: { id: "bot-1" } } as any;

    const handled = await handleUndoCrossReaction(
      { config: { discord: { guildId: "guild-a" } } as any, repo: repo as any, client } as any,
      client,
      reaction as any,
      { id: "user-1", bot: false } as any
    );

    expect(handled).toBe(false);
    expect(repo.deleteConversationMessagesByDiscordMessageIds).not.toHaveBeenCalled();
  });
});

function fakeReaction(overrides: { emoji?: string; message?: any; partial?: boolean } = {}) {
  const message = overrides.message ?? fakeGuildMessage("guild-a");
  return {
    partial: overrides.partial ?? false,
    emoji: { id: null, name: overrides.emoji ?? "❌", animated: false },
    message,
    fetch: async function (this: any) {
      return this;
    }
  };
}

function fakeGuildBotReplyMessage(
  guildId: string,
  botUserId: string,
  messageId: string,
  channel?: { id: string; messages: { delete: (id: string) => Promise<void> } }
) {
  return {
    id: messageId,
    partial: false,
    inGuild: () => true,
    guildId,
    channelId: "channel-1",
    guild: { id: guildId, name: "Test Guild" },
    channel: channel ?? {
      id: "channel-1",
      name: "general",
      type: 0,
      parentId: null,
      isThread: () => false,
      messages: { delete: vi.fn(async () => undefined) }
    },
    author: {
      id: botUserId,
      username: "ai-bot",
      globalName: "AI",
      bot: true
    },
    content: "bot reply",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    editedAt: null,
    type: 0,
    system: false,
    pinned: false,
    url: `https://discord.com/channels/${guildId}/channel-1/${messageId}`,
    reactions: { cache: new Map() },
    attachments: new Map()
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
