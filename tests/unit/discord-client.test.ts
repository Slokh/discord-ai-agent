import { describe, expect, it, vi } from "vitest";
import {
  sendChunkedAgentResponse,
  deletedMessageIdsForConfiguredGuild,
  discordChannelThreadKey,
  explicitChannelMentionIds,
  explicitRoleMentionIds,
  explicitUserMentionIds,
  hasExplicitBotAddress,
  hasExplicitBotMention,
  isSelfMessage,
  persistReactionMessage,
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

describe("sendChunkedAgentResponse", () => {
  function createMockThinking() {
    const editCalls: { content: string; files?: unknown[] }[] = [];
    const thinking = {
      id: "thinking-1",
      url: "https://discord.com/channels/g/c/thinking-1",
      edit: vi.fn(async (opts: { content: string; files?: unknown[] }) => {
        editCalls.push(opts);
        return {
          id: opts.content.length > 100 ? "edited-first" : "thinking-1",
          url: "https://discord.com/channels/g/c/thinking-1",
          content: opts.content,
          files: opts.files
        };
      })
    };
    return { thinking, editCalls };
  }

  function createMockChannel(sends: { id: string; content: string }[]) {
    return {
      send: vi.fn(async (opts: { content: string }) => {
        const msg = { id: `followup-${sends.length + 1}`, content: opts.content, url: `https://discord.com/channels/g/c/followup-${sends.length + 1}` };
        sends.push(msg);
        return msg;
      })
    };
  }

  it("edits the thinking message with the full response when content fits in one chunk", async () => {
    const { thinking, editCalls } = createMockThinking();
    const channel = createMockChannel([]);
    const result = await sendChunkedAgentResponse(channel as any, thinking as any, "Short response");
    expect(result).toHaveLength(1);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0].content).toBe("Short response");
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("splits long content into multiple follow-up messages", async () => {
    const { thinking, editCalls } = createMockThinking();
    const sends: { id: string; content: string }[] = [];
    const channel = createMockChannel(sends);
    const longContent = "a".repeat(3000);
    const result = await sendChunkedAgentResponse(channel as any, thinking as any, longContent);
    expect(result.length).toBeGreaterThan(1);
    expect(editCalls).toHaveLength(1);
    expect(channel.send).toHaveBeenCalled();
    expect(sends.length).toBe(result.length - 1);
    const reassembled = result.map((m) => m.content).join("");
    expect(reassembled.length).toBe(3000);
  });

  it("uses default 'Done.' for empty content", async () => {
    const { thinking, editCalls } = createMockThinking();
    const channel = createMockChannel([]);
    const result = await sendChunkedAgentResponse(channel as any, thinking as any, "");
    expect(result).toHaveLength(1);
    expect(editCalls[0].content).toBe("Done.");
  });

  it("attaches files to the first message only", async () => {
    const { thinking, editCalls } = createMockThinking();
    const sends: { id: string; content: string }[] = [];
    const channel = createMockChannel(sends);
    const files = [{ name: "test.png" }];
    const longContent = "a".repeat(2500);
    await sendChunkedAgentResponse(channel as any, thinking as any, longContent, files as any);
    expect(editCalls[0].files).toHaveLength(1);
    expect(channel.send).toHaveBeenCalled();
  });
});
