import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerFromHistory,
  createSkillFromRequest,
  extractHistorySearchSyntax,
  findDiscordUsers,
  formatAgentTaskResult,
  generateImage,
  getDiscordChannelTopics,
  getDiscordStats,
  inspectAgentLogs,
  reportStatus,
  summarizeDiscordHistory,
  summarizeCurrentThread,
  undoConversationTurns
} from "../../src/tools/coreTools.js";
import type { ToolContext } from "../../src/tools/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("extractHistorySearchSyntax", () => {
  it("extracts absolute since and before dates", () => {
    const filters = extractHistorySearchSyntax("what did we say about pizza since 2024-01-01 before 2024-02-01");
    expect(filters.query).toBe("what did we say about pizza");
    expect(filters.dateFrom?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(filters.dateTo?.toISOString()).toBe("2024-02-01T23:59:59.999Z");
  });

  it("ignores messages without absolute date filters", () => {
    const filters = extractHistorySearchSyntax("what did we say last week");
    expect(filters.dateFrom).toBeUndefined();
    expect(filters.dateTo).toBeUndefined();
  });

  it("extracts colon-style Discord history filters", () => {
    const filters = extractHistorySearchSyntax('from:riverrunner in:"general chat" after:2024-01-01 before:2024-02-01 pizza');

    expect(filters.query).toBe("pizza");
    expect(filters.authorQueries).toEqual(["riverrunner"]);
    expect(filters.channelQueries).toEqual(["general chat"]);
    expect(filters.dateFrom?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(filters.dateTo?.toISOString()).toBe("2024-02-01T23:59:59.999Z");
  });
});

describe("model-led mutating tools", () => {
  it("saves a skill from structured model arguments", async () => {
    const ctx = {
      config: { openRouter: {}, maxReplyChars: 1800 },
      repo: {
        listEnabledDatabaseSkills: vi.fn(async () => []),
        upsertDatabaseSkill: vi.fn(async (input: { name: string; content: string }) => ({
          name: input.name,
          content: input.content,
          source: "database",
          version: 1
        })),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "User",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await createSkillFromRequest(ctx, {
      skillName: "Movie Night",
      instruction: "movie night votes should use the pinned poll"
    });

    expect(response).toBe("Saved private skill `movie-night` to the database (v1).");
    expect(ctx.repo.upsertDatabaseSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "movie-night",
        request: "movie night votes should use the pinned poll"
      })
    );
  });

  it("undoes recent conversation turns through a tool boundary", async () => {
    const deleteDiscordMessageIds = vi.fn(async () => 1);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        deleteMostRecentConversationTurns: vi.fn(async () => ({
          deletedTurns: 2,
          deletedRows: 4,
          assistantDiscordMessageIds: ["reply-1"]
        })),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "User",
      visibleChannelIds: ["channel"],
      threadKey: "discord:guild:channel",
      deleteDiscordMessageIds
    } as unknown as ToolContext;

    const response = await undoConversationTurns(ctx, 2);

    expect(response).toBe("Undid my last 2 turns in this channel and removed 4 memory rows from memory.");
    expect(ctx.repo.deleteMostRecentConversationTurns).toHaveBeenCalledWith({ threadKey: "discord:guild:channel", count: 2 });
    expect(deleteDiscordMessageIds).toHaveBeenCalledWith(["reply-1"]);
  });
});

describe("formatAgentTaskResult", () => {
  it("includes compact timings and cache details for successful code-update PRs", () => {
    const response = formatAgentTaskResult({
      taskId: "task-1",
      jobId: "job-1",
      job: {
        taskId: "task-1",
        pgBossJobId: "job-1",
        status: "succeeded",
        title: "update status",
        prUrl: "https://github.com/example/repo/pull/1",
        draft: false,
        updatedAt: new Date("2026-01-01T00:00:00Z")
      } as any,
      taskEvents: [
        {
          eventName: "task.completed",
          metadata: {
            timingsMs: {
              total: 123_000,
              dependencies: 500,
              codex: 100_000,
              verify: 2_000,
              push: 1_000,
              pr: 750
            },
            cache: {
              repo: "hit",
              dependencies: "miss",
              dependencyCacheKey: "node-22-abcdef1234567890",
              dependencyRefreshAfterCodex: true
            }
          }
        }
      ] as any
    });

    expect(response).toContain("Done: https://github.com/example/repo/pull/1");
    expect(response).toContain("Timings: total=2m 3s");
    expect(response).toContain("codex=1m 40s");
    expect(response).toContain("Cache: repo=hit | deps=miss node-22-abcdef123");
    expect(response).toContain("refreshed deps after Codex");
  });
});

describe("Discord lookup tools", () => {
  it("formats user lookup matches from visible indexed history", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        findDiscordUsers: vi.fn(async () => [
          {
            id: "123",
            username: "riverrunner",
            globalName: "River",
            aliases: ["riverphone"],
            isBot: false,
            messageCount: 42,
            lastMessageAt: new Date("2024-01-01T00:00:00Z"),
            score: 90
          }
        ]),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await findDiscordUsers(ctx, "connor");

    expect(response).toContain("River / @riverrunner id=123");
    expect(response).toContain("aliases=riverphone");
    expect(ctx.repo.findDiscordUsers).toHaveBeenCalledWith({
      guildId: "guild",
      visibleChannelIds: ["channel"],
      query: "connor",
      limit: 8
    });
  });

});

describe("getDiscordStats", () => {
  it("formats permission-filtered indexed Discord stats", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        discordStats: vi.fn(async () => ({
          totalMessages: 10,
          totalAttachments: 2,
          totalReactions: 4,
          userCount: 3,
          channelCount: 1,
          activeDays: 5,
          metric: "messages",
          groupBy: "overall",
          rows: [{ key: "overall", label: "All visible messages", value: 10 }],
          topUsers: [{ authorId: "u1", authorUsername: "alice", messageCount: 7 }],
          topChannels: [{ channelId: "channel", channelName: "general", messageCount: 10 }]
        })),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await getDiscordStats(ctx);

    expect(response).toContain("Messages: 10");
    expect(response).toContain("@alice: 7");
    expect(response).toContain("#general: 10");
  });

  it("passes filters and grouping options through to stats", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        findDiscordUsers: vi.fn(async () => [{ id: "hunter-id", username: "jordan1323", globalName: "Jordan", isBot: false, messageCount: 12 }]),
        discordStats: vi.fn(async () => ({
          totalMessages: 12,
          totalAttachments: 0,
          totalReactions: 0,
          userCount: 1,
          channelCount: 2,
          activeDays: 3,
          metric: "messages",
          groupBy: "channel",
          rows: [
            {
              key: "channel-a",
              label: "general",
              value: 9,
              channelId: "channel-a",
              channelName: "general",
              authorId: null,
              authorUsername: null,
              periodStart: null
            }
          ],
          topUsers: [],
          topChannels: []
        })),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await getDiscordStats(ctx, {
      authorQueries: ["hunter"],
      groupBy: "channel",
      metric: "messages",
      limit: 20
    });

    expect(response).toContain("Grouped by: channel");
    expect(response).toContain("#general: 9");
    expect(ctx.repo.discordStats).toHaveBeenCalledWith(
      expect.objectContaining({
        authorIds: ["hunter-id"],
        groupBy: "channel",
        metric: "messages",
        limit: 20
      })
    );
  });

  it("formats message-level reaction stats with exact message timestamps", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        discordStats: vi.fn(async () => ({
          totalMessages: 1,
          totalAttachments: 0,
          totalReactions: 7,
          userCount: 1,
          channelCount: 1,
          activeDays: 1,
          metric: "reactions",
          groupBy: "message",
          rows: [
            {
              key: "message-1",
              label: "pizza ledger",
              value: 7,
              authorId: "hunter-id",
              authorUsername: "jordan1323",
              channelId: "channel",
              channelName: "lounge",
              messageId: "message-1",
              messageLink: "https://discord.com/channels/guild/channel/message-1",
              periodStart: new Date("2026-04-14T21:17:47.316Z")
            }
          ],
          topUsers: [],
          topChannels: []
        })),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await getDiscordStats(ctx, {
      groupBy: "message",
      metric: "reactions",
      limit: 5
    });

    expect(response).toContain("Grouped by: message");
    expect(response).toContain('@jordan1323 in #lounge at 2026-04-14T21:17:47.316Z: "pizza ledger": 7');
  });

  it("formats normalized channel messages-per-day stats with denominator details", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        discordStats: vi.fn(async () => ({
          totalMessages: 336715,
          totalAttachments: 0,
          totalReactions: 0,
          userCount: 12,
          channelCount: 1,
          activeDays: 3000,
          metric: "messagesPerChannelDay",
          groupBy: "channel",
          rows: [
            {
              key: "channel",
              label: "lounge",
              value: 84.2531,
              authorId: null,
              authorUsername: null,
              channelId: "channel",
              channelName: "lounge",
              messageId: null,
              messageLink: null,
              periodStart: null,
              messageCount: 336715,
              activeDays: 3000,
              channelCreatedAt: new Date("2015-08-15T00:00:00.000Z"),
              channelAgeDays: 3996
            }
          ],
          topUsers: [],
          topChannels: []
        })),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await getDiscordStats(ctx, {
      groupBy: "channel",
      metric: "messagesPerChannelDay",
      sort: "countDesc"
    });

    expect(response).toContain("Metric: messages per channel day");
    expect(response).toContain("#lounge: 84.2531 messages/channel day (336,715 messages over 3,996 days since 2015-08-15)");
  });
});

describe("getDiscordChannelTopics", () => {
  it("summarizes recurring channel topics from embedded sampled messages", async () => {
    const auditTool = vi.fn(async () => undefined);
    const chat = vi.fn(async () => ({
      content: "#stonks: job hunting, startup links, and work complaints.",
      model: "test-chat",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        discordChannelTopicCandidates: vi.fn(async () => [
          topicCandidate("startup jobs are brutal", [1, 0]),
          topicCandidate("interview loops and job offers", [0.95, 0.05]),
          topicCandidate("work complaints are back", [0.9, 0.1]),
          topicCandidate("nvda earnings and markets", [0, 1]),
          topicCandidate("stocks are ripping again", [0.05, 0.95]),
          topicCandidate("market close was wild", [0.1, 0.9])
        ]),
        auditTool
      },
      openRouter: { chat },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await getDiscordChannelTopics(ctx, {
      channelLimit: 1,
      topicsPerChannel: 2,
      samplesPerChannel: 20
    });

    expect(response).toContain("job hunting");
    expect(ctx.repo.discordChannelTopicCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        channelLimit: 1,
        samplesPerChannel: 20
      })
    );
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("#stonks") }),
          expect.objectContaining({ content: expect.stringContaining("startup jobs are brutal") })
        ])
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordChannelTopics" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "composeChannelTopics", model: "test-chat" }));
  });
});

describe("summarizeDiscordHistory", () => {
  it("builds hybrid semantic, keyword, recent, and representative evidence", async () => {
    const semanticResult = searchResult({ messageId: "semantic", normalizedContent: "semantic job interview update", score: 0.91 });
    const keywordResult = searchResult({ messageId: "keyword", normalizedContent: "keyword job hunt update", score: 0.8 });
    const recentResult = searchResult({ messageId: "recent", normalizedContent: "recent career update", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const representativeResult = searchResult({ messageId: "representative", normalizedContent: "representative workplace chatter" });
    const chat = vi.fn(async () => ({
      content: "People have been talking about interviews, job hunts, and career updates.",
      model: "summary-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        openRouter: { apiKey: "test-key", embeddingModel: "test-embed" },
        embeddingDimensions: 2
      },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["jobs"]),
        findDiscordUsers: vi.fn(async () => []),
        findDiscordChannels: vi.fn(async () => []),
        sampleMessagesFromChannels: vi.fn(async () => [representativeResult]),
        recentMessagesFromChannels: vi.fn(async () => [recentResult]),
        keywordSearch: vi.fn(async () => [keywordResult]),
        vectorSearch: vi.fn(async () => [semanticResult]),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        embed: vi.fn(async () => [[0.1, 0.2]]),
        chat
      },
      github: {},
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "User",
      visibleChannelIds: ["jobs"]
    } as unknown as ToolContext;

    const response = await summarizeDiscordHistory(ctx, {
      question: "what have people said about job hunting?",
      channelIds: ["jobs"],
      sampleLimit: 20
    });

    expect(response).toContain("job hunts");
    expect(ctx.openRouter.embed).toHaveBeenCalledWith(["what have people said about job hunting?"], "test-embed", 2);
    expect(ctx.repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["jobs"], authorIds: [], limit: 10 }));
    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "what have people said about job hunting?", channelIds: ["jobs"] }));
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["jobs"] }));
    expect(ctx.repo.sampleMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["jobs"], limit: 20 }));
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("Retrieval mix: semantic=1, keyword=1, recent=1, representative=1") }),
          expect.objectContaining({ content: expect.stringContaining("semantic job interview update") })
        ])
      })
    );
  });
});

describe("answerFromHistory", () => {
  it("returns a deterministic no-results answer without asking the model to compose from empty evidence", async () => {
    const chat = vi.fn();
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: {
        maxHistoryResults: 10,
        openRouter: { apiKey: "test-key", embeddingModel: "test-embed" },
        embeddingDimensions: 2
      },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        keywordSearch: vi.fn(async () => []),
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => [{ status: "running", channels: 2, messages: 10 }]),
        auditTool
      },
      openRouter: {
        embed: vi.fn(async () => [[0.1, 0.2]]),
        chat
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await answerFromHistory(ctx, "what did we say about pizza?");

    expect(response).toContain("did not find matching indexed Discord messages");
    expect(response).toContain("running=2 channels/10 messages");
    expect(chat).not.toHaveBeenCalled();
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "searchDiscordHistory" }));
  });

  it("returns search evidence without asking the model to compose", async () => {
    const result = searchResult();
    const ctx = historyAnswerContext({
      keywordResults: [
        result,
        searchResult({
          messageId: "message-2",
          createdAt: new Date("2025-06-15T00:00:00.000Z"),
          normalizedContent: "pizza party happened later",
          link: "https://discord.com/channels/guild/channel/message-2"
        })
      ]
    });

    const response = await answerFromHistory(ctx, "what did we say about pizza?");

    expect(response).toContain("Discord search evidence:");
    expect(response).toContain("Question: what did we say about pizza?");
    expect(response).toContain("Effective query: what did we say about pizza?");
    expect(response).toContain("Applied date filter: none");
    expect(response).toContain("Evidence dates: 2024-01-01 to 2025-06-15");
    expect(response).toContain("Evidence authors: @alice");
    expect(response).toContain("These are historical Discord messages, not necessarily recent/current events.");
    expect(response).toContain("use only the exact @handles or IDs shown");
    expect(response).toContain("Use links only if helpful or if the user asked for links");
    expect(response).toContain("pizza night is friday");
    expect(response).toContain(result.link);
    expect(ctx.openRouter.chat).not.toHaveBeenCalled();
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "searchDiscordHistory" }));
    expect(ctx.repo.auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "composeHistoryAnswer" }));
  });

  it("returns links in evidence for the model to use when sources are requested", async () => {
    const result = searchResult();
    const ctx = historyAnswerContext({
      keywordResults: [result]
    });

    const response = await answerFromHistory(ctx, "what did we say about pizza? show sources");

    expect(response).toContain("Use links only if helpful or if the user asked for links");
    expect(response).toContain(result.link);
  });

  it("returns links in evidence for the model to use when message links are requested", async () => {
    const result = searchResult();
    const ctx = historyAnswerContext({
      keywordResults: [result]
    });

    const response = await answerFromHistory(ctx, "link to the message about pizza");

    expect(response).toContain("Use links only if helpful or if the user asked for links");
    expect(response).toContain(result.link);
  });

  it("treats filter-only from: syntax as a broad author scan", async () => {
    const result = searchResult({ authorId: "rare-user-id", authorUsername: "rare_guest_0001", normalizedContent: "Wordle 218 1/6" });
    const ctx = historyAnswerContext({
      keywordResults: [],
      recentResults: [result],
      userMatches: [{ id: "rare-user-id", username: "rare_guest_0001", globalName: null, aliases: [], isBot: false, messageCount: 4, lastMessageAt: null, score: 90 }]
    });

    const response = await answerFromHistory(ctx, "from:rare_guest_0001");

    expect(response).toContain("Effective query: (recent messages)");
    expect(response).toContain("Wordle 218 1/6");
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        authorIds: ["rare-user-id"]
      })
    );
  });

  it("runs broad author scans when the model passes an empty query with an author filter", async () => {
    const result = searchResult({ authorId: "rare-user-id", authorUsername: "rare_guest_0001", normalizedContent: "Wordle 218 1/6" });
    const ctx = historyAnswerContext({
      keywordResults: [],
      recentResults: [result]
    });

    const response = await answerFromHistory(ctx, "", {
      authorIds: ["rare-user-id"],
      requestText: "link to the message from rare_guest_0001"
    });

    expect(response).toContain("Effective query: (recent messages)");
    expect(response).toContain(result.link);
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        authorIds: ["rare-user-id"]
      })
    );
    expect(ctx.repo.keywordSearch).not.toHaveBeenCalled();
  });

  it("runs broad resolved-user scans when the model passes an empty query", async () => {
    const result = searchResult({ authorId: "rare-user-id", authorUsername: "rare_guest_0001", normalizedContent: "is the ram all the way in" });
    const ctx = historyAnswerContext({
      keywordResults: [],
      recentResults: [result]
    });

    const response = await answerFromHistory(ctx, "", {
      authorIds: ["rare-user-id"],
      requestText: "bro i want the source link for pony's message"
    });

    expect(response).toContain("Effective query: (recent messages)");
    expect(response).toContain(result.link);
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        authorIds: ["rare-user-id"]
      })
    );
  });

  it("keeps the topic query when a resolved link request asks about a topic", async () => {
    const result = searchResult({ authorId: "rare-user-id", authorUsername: "rare_guest_0001", normalizedContent: "pizza night is friday" });
    const ctx = historyAnswerContext({
      keywordResults: [result],
      recentResults: []
    });

    const response = await answerFromHistory(ctx, "pizza", {
      authorIds: ["rare-user-id"],
      requestText: "link to the message from rare_guest_0001 about pizza"
    });

    expect(response).toContain("Effective query: pizza");
    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "pizza",
        authorIds: ["rare-user-id"]
      })
    );
    expect(ctx.repo.recentMessagesFromChannels).not.toHaveBeenCalled();
  });

  it("uses about-user filters for subject requests instead of author filters", async () => {
    const result = searchResult({ normalizedContent: "happy birthday casey" });
    const ctx = historyAnswerContext({
      keywordResults: [result],
      userMatches: [{ id: "casey-id", username: "caseyuser", globalName: "Casey", aliases: ["case"], isBot: false, messageCount: 10, lastMessageAt: null, score: 90 }]
    });

    const response = await answerFromHistory(ctx, "birthday", {
      aboutUserQueries: ["casey"],
      requestText: "when is my birthday"
    });

    expect(response).toContain("happy birthday casey");
    expect(ctx.repo.findDiscordUsers).toHaveBeenCalledWith(expect.objectContaining({ query: "casey" }));
    expect(ctx.repo.getDiscordUserReferenceTerms).toHaveBeenCalledWith({ guildId: "guild", userIds: ["casey-id"] });
    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        authorIds: [],
        aboutUserTerms: ["@user:casey-id", "caseyuser", "casey", "case"]
      })
    );
  });

  it("uses the same link guidance for normal uses of the word source", async () => {
    const result = searchResult({ normalizedContent: "open source tools are useful" });
    const ctx = historyAnswerContext({
      keywordResults: [result]
    });

    const response = await answerFromHistory(ctx, "what did we say about open source?");

    expect(response).toContain("Use links only if helpful or if the user asked for links");
    expect(response).toContain("open source tools are useful");
  });

  it("does not add a hidden date window for vague recent history questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:00.000Z"));
    const result = searchResult({ createdAt: new Date("2025-09-15T15:36:25.540Z") });
    const ctx = historyAnswerContext({
      keywordResults: [result]
    });

    const response = await answerFromHistory(ctx, "has anyone changed jobs or careers recentyl");

    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFrom: undefined,
        dateTo: undefined
      })
    );
    expect(response).toContain("Applied date filter: none");
  });
});

function historyAnswerContext(input: { keywordResults: any[]; recentResults?: any[]; userMatches?: any[] }) {
  const auditTool = vi.fn(async () => undefined);
  return {
    config: {
      maxHistoryResults: 10,
      openRouter: { apiKey: "test-key", embeddingModel: "test-embed" },
      embeddingDimensions: 2
    },
    repo: {
      getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
      findDiscordUsers: vi.fn(async () => input.userMatches ?? []),
      getDiscordUserReferenceTerms: vi.fn(async ({ userIds }: { userIds: string[] }) =>
        userIds.map((userId) => ({
          userId,
          username: userId === "casey-id" ? "caseyuser" : userId,
          globalName: userId === "casey-id" ? "Casey" : null,
          aliases: userId === "casey-id" ? ["case"] : [],
          terms: userId === "casey-id" ? ["@user:casey-id", "caseyuser", "casey", "case"] : [`@user:${userId}`, userId]
        }))
      ),
      keywordSearch: vi.fn(async () => input.keywordResults),
      vectorSearch: vi.fn(async () => []),
      recentMessagesFromChannels: vi.fn(async () => input.recentResults ?? []),
      getCrawlStatus: vi.fn(async () => []),
      auditTool
    },
    openRouter: {
      embed: vi.fn(async () => [[0.1, 0.2]]),
      chat: vi.fn()
    },
    github: {},
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"]
  } as any;
}

function searchResult(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message-1",
    guildId: "guild",
    channelId: "channel",
    authorId: "alice-id",
    authorUsername: "alice",
    content: "pizza night is friday",
    normalizedContent: "pizza night is friday",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    score: 1,
    link: "https://discord.com/channels/guild/channel/message-1",
    ...overrides
  };
}

function topicCandidate(content: string, embedding: number[]) {
  return {
    channelId: "stonks",
    channelName: "stonks",
    messageId: `message-${content}`,
    authorUsername: "alice",
    normalizedContent: content,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    embedding,
    channelMessageCount: 1000
  };
}

describe("generateImage", () => {
  it("uses returned media types for attached image files and audits estimated cost", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      repo: { auditTool },
      openRouter: {
        generateImage: vi.fn(async () => ({
          model: "test/image",
          estimatedCostUsd: 0.031,
          raw: {},
          data: [
            {
              b64_json: Buffer.from("<svg></svg>").toString("base64"),
              media_type: "image/svg+xml"
            }
          ]
        }))
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user"
    } as unknown as ToolContext;

    const result = await generateImage(ctx, "logo");

    expect(result.files[0]).toMatchObject({
      name: expect.stringMatching(/\.svg$/),
      contentType: "image/svg+xml"
    });
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "generateImage",
        estimatedCostUsd: 0.031
      })
    );
  });

  it("fetches returned image URLs into attachments when possible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => Buffer.from("image-data").buffer
      }))
    );
    const ctx = {
      repo: { auditTool: vi.fn(async () => undefined) },
      openRouter: {
        generateImage: vi.fn(async () => ({
          model: "test/image",
          raw: {},
          data: [{ url: "https://example.com/generated.webp" }]
        }))
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user"
    } as unknown as ToolContext;

    const result = await generateImage(ctx, "logo");

    expect(result.content).toBe("Generated image for: logo");
    expect(result.files[0]).toMatchObject({
      name: expect.stringMatching(/\.webp$/),
      contentType: "image/webp"
    });
  });

  it("falls back to image URLs when attachment fetching fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: { get: () => "text/html" },
        arrayBuffer: async () => new ArrayBuffer(0)
      }))
    );
    const ctx = {
      repo: { auditTool: vi.fn(async () => undefined) },
      openRouter: {
        generateImage: vi.fn(async () => ({
          model: "test/image",
          raw: {},
          data: [{ url: "https://example.com/generated.png" }]
        }))
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user"
    } as unknown as ToolContext;

    const result = await generateImage(ctx, "logo");

    expect(result.files).toEqual([]);
    expect(result.content).toContain("https://example.com/generated.png");
  });
});

describe("reportStatus", () => {
  it("includes logged model cost estimates", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      repo: {
        health: vi.fn(async () => ({ messages: 2, embeddings: 1, toolCalls: 3, estimatedCostUsd: 0.12345 })),
        getCrawlStatus: vi.fn(async () => []),
        embeddingBacklog: vi.fn(async () => 4),
        interactionBlockCount: vi.fn(async () => 1),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      config: { openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } }
    } as unknown as ToolContext;

    const response = await reportStatus(ctx);
    expect(response).toContain("Estimated model cost logged: $0.1235");
    expect(response).toContain("Embeddings pending/backfill: 4");
    expect(response).toContain("Interaction-blocked users: 1");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "reportStatus" }));
  });
});

describe("inspectAgentLogs", () => {
  it("formats trace events and tool audit logs", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      repo: {
        getTraceEvents: vi.fn(async () => [
          {
            id: 1,
            traceId: "trace-1",
            requestId: "trace-1",
            guildId: "guild",
            channelId: "channel",
            userId: "user",
            messageId: "trace-1",
            eventName: "agent.request.started",
            level: "info",
            summary: "hello",
            metadata: {},
            durationMs: null,
            createdAt: new Date("2026-01-01T00:00:00Z")
          },
          {
            id: 2,
            traceId: "trace-1",
            requestId: "trace-1",
            guildId: "guild",
            channelId: "channel",
            userId: "user",
            messageId: "trace-1",
            eventName: "agent.request.complete",
            level: "info",
            summary: "done",
            metadata: {},
            durationMs: 1234,
            createdAt: new Date("2026-01-01T00:00:01Z")
          }
        ]),
        getToolAuditLogs: vi.fn(async () => [
          {
            id: 1,
            traceId: "trace-1",
            guildId: "guild",
            channelId: "channel",
            userId: "user",
            toolName: "searchDiscordHistory",
            argumentsSummary: "pizza",
            resultSummary: "found pizza",
            error: null,
            model: "chat-model",
            estimatedCostUsd: 0.001,
            createdAt: new Date("2026-01-01T00:00:02Z")
          }
        ]),
        getTaskEvents: vi.fn(async () => [
          {
            id: 1,
            taskId: "task-1",
            traceId: "trace-1",
            eventName: "task.progress",
            level: "info",
            summary: "Kubernetes sandbox is running the task.",
            metadata: { step: "sandbox_running" },
            createdAt: new Date("2026-01-01T00:00:03Z")
          }
        ]),
        getSandboxCommandEvents: vi.fn(async () => [
          {
            id: 1,
            taskId: "task-1",
            sandboxRunId: "run-1",
            step: "verify",
            command: "npm run verify",
            exitCode: 1,
            outputTail: "",
            errorTail: "test failure",
            durationMs: 123,
            createdAt: new Date("2026-01-01T00:00:04Z")
          }
        ]),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await inspectAgentLogs(ctx, { traceId: "trace-1", limit: 10 });

    expect(response).toContain("Discord AI Agent logs for trace trace-1");
    expect(response).toContain("agent.request.complete 1234ms");
    expect(response).toContain("task.progress task=task-1");
    expect(response).toContain("Sandbox commands:");
    expect(response).toContain("npm run verify");
    expect(response).toContain("searchDiscordHistory");
    expect(ctx.repo.getTraceEvents).toHaveBeenCalledWith({
      guildId: "guild",
      visibleChannelIds: ["channel"],
      traceId: "trace-1",
      limit: 10
    });
    expect(ctx.repo.getTaskEvents).toHaveBeenCalledWith({
      guildId: "guild",
      visibleChannelIds: ["channel"],
      traceId: "trace-1",
      limit: 10
    });
    expect(ctx.repo.getSandboxCommandEvents).toHaveBeenCalledWith({
      guildId: "guild",
      visibleChannelIds: ["channel"],
      traceId: "trace-1",
      limit: 10
    });
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "inspectAgentLogs" }));
  });
});

describe("summarizeCurrentThread", () => {
  it("does not load messages when the current channel is not visible to the requester", async () => {
    const recentMessages = vi.fn();
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["other-channel"]),
        recentMessages,
        auditTool
      },
      guildId: "guild",
      channelId: "private-channel",
      userId: "user",
      visibleChannelIds: ["public-channel"],
      config: { maxThreadSummaryMessages: 80 },
      openRouter: { chat: vi.fn() }
    } as unknown as ToolContext;

    const response = await summarizeCurrentThread(ctx);

    expect(response).toContain("current visibility grant");
    expect(recentMessages).not.toHaveBeenCalled();
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "summarizeDiscordThread",
        resultSummary: "permission_denied"
      })
    );
  });

  it("summarizes indexed messages only after current-channel visibility is confirmed", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        recentMessages: vi.fn(async () => [
          {
            authorUsername: "alice",
            authorId: "alice-id",
            normalizedContent: "we picked nachos",
            createdAt: new Date("2024-01-01T00:00:00Z")
          }
        ]),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({ content: "Nachos won.", model: "test", raw: {} }))
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      config: { maxThreadSummaryMessages: 80 }
    } as unknown as ToolContext;

    await expect(summarizeCurrentThread(ctx)).resolves.toBe("Nachos won.");
    expect(ctx.repo.recentMessages).toHaveBeenCalledWith({
      guildId: "guild",
      channelId: "channel",
      limit: 80
    });
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.stringContaining("we picked nachos") })])
      })
    );
  });

  it("uses hybrid focused evidence when a thread summary has a question", async () => {
    const ctx = {
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        sampleMessagesFromChannels: vi.fn(async () => [
          searchResult({ messageId: "representative-thread", channelId: "channel", normalizedContent: "older deploy context" })
        ]),
        recentMessagesFromChannels: vi.fn(async () => [
          searchResult({ messageId: "recent-thread", channelId: "channel", normalizedContent: "recent deploy update" })
        ]),
        keywordSearch: vi.fn(async () => [
          searchResult({ messageId: "keyword-thread", channelId: "channel", normalizedContent: "deploy keyword hit" })
        ]),
        vectorSearch: vi.fn(async () => [
          searchResult({ messageId: "semantic-thread", channelId: "channel", normalizedContent: "semantic deploy decision" })
        ]),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        embed: vi.fn(async () => [[0.1, 0.2]]),
        chat: vi.fn(async () => ({ content: "Deployment decision summarized.", model: "test", raw: {} }))
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      config: {
        maxThreadSummaryMessages: 20,
        openRouter: { apiKey: "test-key", embeddingModel: "test-embed" },
        embeddingDimensions: 2
      }
    } as unknown as ToolContext;

    await expect(summarizeCurrentThread(ctx, { question: "deployment decisions" })).resolves.toBe("Deployment decision summarized.");
    expect(ctx.repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["channel"] }));
    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["channel"], query: "deployment decisions" }));
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["channel"] }));
    expect(ctx.repo.sampleMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["channel"] }));
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: expect.stringContaining("Question: deployment decisions") }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("semantic deploy decision") })
        ])
      })
    );
  });
});
