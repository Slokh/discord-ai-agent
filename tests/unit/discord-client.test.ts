import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/agent/router.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent/router.js")>("../../src/agent/router.js");
  return {
    ...actual,
    handleAgentRequest: vi.fn()
  };
});
import {
  DISCORD_LOADING_REACTION,
  deletedMessageIdsForConfiguredGuild,
  discordChannelThreadKey,
  explicitChannelMentionIds,
  explicitRoleMentionIds,
  explicitUserMentionIds,
  handleMessageCreate,
  hasExplicitBotAddress,
  hasExplicitBotMention,
  isSelfMessage,
  persistReactionMessage,
  runQueuedDiscordAgentRequest,
  shouldProcessGuildEvent,
  stripBotAddress
} from "../../src/discord/client.js";
import { handleAgentRequest } from "../../src/agent/router.js";

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

describe("Discord loading reaction lifecycle", () => {
  beforeEach(() => {
    vi.mocked(handleAgentRequest).mockReset();
  });

  it("reacts with the loading emoji and queues work without sending a thinking reply", async () => {
    const repo = fullRepo();
    const jobs = {
      enqueueDiscordAgentRequest: vi.fn(async () => "job-1")
    };
    const client = { user: { id: "bot", username: "ai" } } as any;
    const message = fakeMentionMessage();

    await handleMessageCreate(
      {
        config: { discord: { guildId: "guild-a" }, maxReplyChars: 2_000 } as any,
        repo: repo as any,
        openRouter: {} as any,
        jobs: jobs as any
      },
      client,
      message as any
    );

    expect(message.react).toHaveBeenCalledWith(DISCORD_LOADING_REACTION);
    expect(message.reply).not.toHaveBeenCalled();
    expect(jobs.enqueueDiscordAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "message-1",
        messageId: "message-1",
        text: "hello"
      })
    );
  });

  it("removes the loading reaction from the prompt message and replies with the final answer", async () => {
    const repo = fullRepo();
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "final answer" });
    const message = fakeMentionMessage();
    const client = fakeClientForQueuedMessage(message);

    await runQueuedDiscordAgentRequest(
      {
        config: { discordAgentResponseTimeoutMs: 5_000, maxReplyChars: 2_000 } as any,
        repo: repo as any,
        openRouter: {} as any,
        client
      },
      {
        runId: "run-1",
        traceId: "run-1",
        guildId: "guild-a",
        channelId: "channel-1",
        messageId: "message-1",
        userId: "author-1",
        text: "hello",
        rawContent: "<@bot> hello",
        mentionKind: "user",
        botRoleIds: [],
        requesterDisplayName: "Alice",
        enqueuedAt: new Date("2024-01-01T00:00:00.000Z").toISOString()
      }
    );

    expect(message.reply).toHaveBeenCalledWith({ content: "final answer", files: undefined });
    expect(message.loadingReaction.users.remove).toHaveBeenCalledWith("bot");
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

function fullRepo() {
  return {
    ...fakeRepo(),
    isUserInteractionBlocked: vi.fn(async () => false),
    upsertProcessRun: vi.fn(async () => undefined),
    storeProcessRunArtifact: vi.fn(async () => undefined),
    updateProcessRun: vi.fn(async () => undefined),
    ensureConversationSession: vi.fn(async () => undefined),
    recentConversationMessages: vi.fn(async () => []),
    appendConversationMessage: vi.fn(async () => undefined),
    recordProcessRunSpan: vi.fn(async () => undefined),
    recordTraceEvent: vi.fn(async () => undefined),
    getProcessRun: vi.fn(async () => null),
    deleteConversationMessagesByDiscordMessageIds: vi.fn(async () => 0),
    auditTool: vi.fn(async () => undefined)
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

function fakeMentionMessage() {
  const finalReply = { id: "reply-1", url: "https://discord.com/channels/guild-a/channel-1/reply-1", channelId: "channel-1", edit: vi.fn() };
  const loadingReaction = {
    emoji: { id: "1521299407214084337", name: "loading", animated: true },
    users: { remove: vi.fn(async () => undefined) }
  };
  const reactionCache = {
    find: (predicate: (reaction: typeof loadingReaction) => boolean) => [loadingReaction].find(predicate),
    values: () => [loadingReaction][Symbol.iterator]()
  };
  const channel = {
    id: "channel-1",
    name: "general",
    type: 0,
    parentId: null,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: vi.fn(async () => message)
    }
  };
  const member = {
    id: "author-1",
    guild: { id: "guild-a" },
    displayName: "Alice",
    nickname: null,
    joinedAt: null,
    roles: { cache: new Map([["guild-a", {}], ["role-1", {}]]) }
  };
  const guild = {
    id: "guild-a",
    name: "Test Guild",
    members: { fetch: vi.fn(async () => member) },
    channels: { fetch: vi.fn(async () => channel), cache: new Map([["channel-1", channel]]) }
  };
  const message: any = {
    id: "message-1",
    partial: false,
    inGuild: () => true,
    guildId: "guild-a",
    guild,
    channel,
    channelId: "channel-1",
    author: { id: "author-1", username: "alice", globalName: "Alice", bot: false },
    member,
    content: "<@bot> hello",
    cleanContent: "@ai hello",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    createdTimestamp: new Date("2024-01-01T00:00:00.000Z").getTime(),
    editedAt: null,
    editedTimestamp: null,
    type: 0,
    system: false,
    pinned: false,
    reference: null,
    url: "https://discord.com/channels/guild-a/channel-1/message-1",
    mentions: { everyone: false, users: new Map(), roles: new Map(), channels: new Map() },
    reactions: { cache: reactionCache },
    attachments: new Map(),
    react: vi.fn(async () => loadingReaction),
    reply: vi.fn(async (payload: any) => (typeof payload === "string" ? { ...finalReply, content: payload } : { ...finalReply, ...payload })),
    fetchReference: vi.fn(),
    client: { user: { id: "bot" } },
    loadingReaction
  };
  channel.messages.fetch.mockResolvedValue(message);
  return message;
}

function fakeClientForQueuedMessage(message: any) {
  return {
    user: { id: "bot", username: "ai" },
    isReady: () => true,
    channels: {
      fetch: vi.fn(async () => message.channel)
    }
  } as any;
}
