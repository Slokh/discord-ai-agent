import { afterEach, describe, expect, it, vi } from "vitest";
import { agentUpdateTitleFromRequest, formatAgentTaskResult } from "../../src/tools/agentTaskFormatting.js";
import {
  createAgentUpdateFromRequest,
  getAgentTaskStatus,
  getDeploymentStatus,
} from "../../src/tools/agentTaskTools.js";
import { extractHistorySearchSyntax } from "../../src/tools/discordHistoryFormatting.js";
import { inspectAgentLogs, reportStatus } from "../../src/tools/discordOpsTools.js";
import {
  answerFromHistory,
  getDiscordStats,
} from "../../src/tools/discordRetrievalTools.js";
import {
  getDiscordChannelTopics,
  summarizeDiscordHistory,
  summarizeCurrentThread,
} from "../../src/tools/discordSummaryTools.js";
import { findDiscordUsers } from "../../src/tools/discordResolverTools.js";
import { undoConversationTurns } from "../../src/tools/agentMemoryTools.js";
import { generateImage, getDiscordUserAvatar, inspectDiscordImages } from "../../src/tools/imageTools.js";
import { createSkillFromRequest } from "../../src/tools/skillTools.js";
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
  it("builds concise human titles for code-update requests", () => {
    expect(
      agentUpdateTitleFromRequest(
        'instead of replying "Thinking..." when prompted, can you just react with the <a:loading:123456789012345678> emoji to the prompt. Then reply as normal. open a PR'
      )
    ).toBe("Replace Thinking reply with loading emoji");
    expect(agentUpdateTitleFromRequest("add a calendar integration")).toBe("Add a calendar integration");
    expect(agentUpdateTitleFromRequest("add a calendar integration", "Add calendar support")).toBe("Add calendar support");
  });

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

  it("replies with a clear not-configured message instead of enqueueing code updates", async () => {
    const enqueueAgentTask = vi.fn(async () => ({ jobId: "job-1" }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        github: {},
        openRouter: { codegenModel: "z-ai/glm-5.2" },
        execution: { codegenBackend: "local-process", codegenHarness: "opencode" }
      },
      repo: { auditTool: vi.fn(async () => undefined) },
      jobs: { enqueueAgentTask },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "User",
      visibleChannelIds: ["channel"],
      threadKey: "discord:guild:channel"
    } as unknown as ToolContext;

    const response = await createAgentUpdateFromRequest(ctx, "add a calendar integration");

    expect(response).toContain("Code-update tasks are not configured on this bot");
    expect(response).toContain("GITHUB_REPOSITORY");
    expect(response).toContain("TASK_SIGNING_SECRET");
    expect(enqueueAgentTask).not.toHaveBeenCalled();
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

  it("includes a run-console link when one is provided", () => {
    const response = formatAgentTaskResult({
      taskId: "task-1",
      jobId: "job-1",
      runConsoleUrl: "https://tasks.example/runs/task-1"
    });

    expect(response).toContain("Working on it...");
    expect(response).toContain("Run console: https://tasks.example/runs/task-1");
  });

  it("uses failure diagnosis details for no-change code-update results", () => {
    const response = formatAgentTaskResult({
      taskId: "task-1",
      jobId: "job-1",
      job: {
        taskId: "task-1",
        pgBossJobId: "job-1",
        status: "no_changes",
        title: "update status",
        error: "Agent task produced no diff.",
        updatedAt: new Date("2026-01-01T00:00:00Z")
      } as any,
      taskEvents: [
        {
          eventName: "task.completed",
          metadata: {
            failureDiagnosis: {
              category: "no_first_edit",
              summary: "OpenCode finished without making a code edit, so no PR was opened.",
              nextAction: "Improve context packaging so the agent makes an early focused edit.",
              finalResponse: "The limit is defined in src/agent/router.ts and should be raised there."
            }
          }
        }
      ] as any
    });

    expect(response).toContain("No PR opened: OpenCode finished without making a code edit, so no PR was opened. Task ID: `task-1`.");
    expect(response).toContain("Agent answer:\nThe limit is defined in src/agent/router.ts and should be raised there.");
    expect(response).toContain("Next: Improve context packaging so the agent makes an early focused edit.");
    expect(response).not.toContain("the coding agent did not produce a code diff");
  });

  it("uses failure diagnosis details for failed code-update results", () => {
    const response = formatAgentTaskResult({
      taskId: "task-1",
      jobId: "job-1",
      job: {
        taskId: "task-1",
        pgBossJobId: "job-1",
        status: "failed",
        title: "update status",
        error: "sandbox failed",
        updatedAt: new Date("2026-01-01T00:00:00Z")
      } as any,
      taskEvents: [
        {
          eventName: "task.completed",
          metadata: {
            failureDiagnosis: {
              category: "release_scan",
              summary: "The agent produced changes, but the release scan failed before the branch was pushed.",
              nextAction: "Inspect the release scan command log."
            }
          }
        }
      ] as any
    });

    expect(response).toContain("No PR opened: The agent produced changes, but the release scan failed before the branch was pushed.");
    expect(response).toContain("Next: Inspect the release scan command log.");
    expect(response).not.toContain("the sandbox failed");
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
    expect(response).toContain("Scope: requester-visible indexed Discord messages");
    expect(response).toContain("Applied filters: none");
    expect(response).toContain("Row limit: 10");
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
    expect(response).toContain("Applied filters: authorIds=hunter-id");
    expect(response).toContain("Row limit: 20");
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
    expect(response).toContain("Discord channel topics summary:");
    expect(response).toContain("Scope: requester-visible indexed Discord messages");
    expect(response).toContain("Sampling: 6 candidate messages across 1 channels (6 embedded)");
    expect(response).toContain("Coverage: directional semantic sample, not an exhaustive exact phrase count");
    expect(response).toContain("Summary:");
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
        openRouter: { apiKey: "test-key", embeddingModel: "test-embed", utilityModel: "utility-summary" },
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
    expect(response).toContain("Discord history summary:");
    expect(response).toContain("Scope: requester-visible indexed Discord messages");
    expect(response).toContain("Question: what have people said about job hunting?");
    expect(response).toContain("Applied filters: channelIds=jobs");
    expect(response).toContain("Retrieval mix: semantic=1, keyword=1, recent=1, representative=1");
    expect(response).toContain("Sample count: 4/20");
    expect(response).toContain("Coverage: representative sample, not exhaustive");
    expect(response).toContain("Summary:");
    expect(ctx.openRouter.embed).toHaveBeenCalledWith(["what have people said about job hunting?"], "test-embed", 2);
    expect(ctx.repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["jobs"], authorIds: [], limit: 10 }));
    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "what have people said about job hunting?", channelIds: ["jobs"] }));
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["jobs"] }));
    expect(ctx.repo.sampleMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ channelIds: ["jobs"], limit: 20 }));
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "utility-summary",
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
    const result = searchResult({ normalizedContent: "happy birthday usera-aliasy" });
    const ctx = historyAnswerContext({
      keywordResults: [result],
      userMatches: [{ id: "user-a-id", username: "usera", globalName: "UserA", aliases: ["usera-alias"], isBot: false, messageCount: 10, lastMessageAt: null, score: 90 }]
    });

    const response = await answerFromHistory(ctx, "birthday", {
      aboutUserQueries: ["usera-aliasy"],
      requestText: "when is my birthday"
    });

    expect(response).toContain("happy birthday usera-aliasy");
    expect(ctx.repo.findDiscordUsers).toHaveBeenCalledWith(expect.objectContaining({ query: "usera-aliasy" }));
    expect(ctx.repo.getDiscordUserReferenceTerms).toHaveBeenCalledWith({ guildId: "guild", userIds: ["user-a-id"] });
    expect(ctx.repo.keywordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        authorIds: [],
        aboutUserTerms: ["@user:user-a-id", "usera", "usera-aliasy", "usera-alias"]
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
          username: userId === "user-a-id" ? "usera" : userId,
          globalName: userId === "user-a-id" ? "UserA" : null,
          aliases: userId === "user-a-id" ? ["usera-alias"] : [],
          terms: userId === "user-a-id" ? ["@user:user-a-id", "usera", "usera-aliasy", "usera-alias"] : [`@user:${userId}`, userId]
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

  it("passes current Discord image attachments as generation references", async () => {
    const generateImageMock = vi.fn(async () => ({
      model: "test/image",
      raw: {},
      data: []
    }));
    const ctx = {
      repo: { auditTool: vi.fn(async () => undefined) },
      openRouter: { generateImage: generateImageMock },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      requestAttachments: [
        {
          id: "attachment-1",
          url: "https://cdn.discordapp.com/image.png",
          filename: "image.png",
          contentType: "image/png",
          width: 640,
          height: 480
        }
      ]
    } as unknown as ToolContext;

    const result = await generateImage(ctx, { prompt: "turn this into pixel art" });

    expect(result.content).toBe("Generated image for: turn this into pixel art\nUsed 1 reference image.");
    expect(generateImageMock).toHaveBeenCalledWith("turn this into pixel art", {
      inputReferences: [{ type: "image_url", image_url: { url: "https://cdn.discordapp.com/image.png" } }]
    });
  });

  it("inspects current Discord image attachments with a vision model", async () => {
    const auditTool = vi.fn(async () => undefined);
    const chat = vi.fn(async () => ({
      content: "It looks like a dashboard screenshot.",
      model: "vision-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      repo: { auditTool },
      openRouter: { chat },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      requestAttachments: [
        {
          id: "attachment-1",
          url: "https://cdn.discordapp.com/screenshot.png",
          filename: "screenshot.png",
          contentType: "image/png",
          width: 1200,
          height: 800
        }
      ]
    } as unknown as ToolContext;

    const result = await inspectDiscordImages(ctx, { question: "what is this?" });

    expect(result).toContain("It looks like a dashboard screenshot.");
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google/gemini-3.1-flash-lite",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: expect.stringContaining("what is this?") }),
              { type: "image_url", image_url: { url: "https://cdn.discordapp.com/screenshot.png" } }
            ])
          })
        ])
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "inspectDiscordImages" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "inspectDiscordImagesResult", model: "vision-model" }));
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

describe("getDiscordUserAvatar", () => {
  it("resolves a mention directly and returns the avatar URL via the discord client callback", async () => {
    const auditTool = vi.fn(async () => undefined);
    const findDiscordUsers = vi.fn(async () => []);
    const fetchDiscordUserAvatar = vi.fn(async () => ({
      avatarUrl: "https://cdn.discordapp.com/avatars/123/abc.png",
      globalAvatarUrl: null,
      username: "kartik",
      globalName: "Kartik",
      isBot: false,
      hasCustomAvatar: true
    }));
    const ctx = {
      repo: { auditTool, findDiscordUsers },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      fetchDiscordUserAvatar
    } as unknown as ToolContext;

    const result = await getDiscordUserAvatar(ctx, { query: "<@123>" });

    expect(findDiscordUsers).not.toHaveBeenCalled();
    expect(fetchDiscordUserAvatar).toHaveBeenCalledWith({ guildId: "guild", userId: "123" });
    expect(result).toContain("https://cdn.discordapp.com/avatars/123/abc.png");
    expect(result).toContain("inspectDiscordImages");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordUserAvatar" }));
  });

  it("resolves a bare user ID without hitting the user resolver", async () => {
    const findDiscordUsers = vi.fn(async () => []);
    const fetchDiscordUserAvatar = vi.fn(async () => ({
      avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
      globalAvatarUrl: null,
      username: null,
      globalName: null,
      isBot: false,
      hasCustomAvatar: false
    }));
    const ctx = {
      repo: { auditTool: vi.fn(async () => undefined), findDiscordUsers },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      fetchDiscordUserAvatar
    } as unknown as ToolContext;

    const result = await getDiscordUserAvatar(ctx, { query: "1234567890123459876" });

    expect(findDiscordUsers).not.toHaveBeenCalled();
    expect(fetchDiscordUserAvatar).toHaveBeenCalledWith({ guildId: "guild", userId: "1234567890123459876" });
    expect(result).toContain("default_avatar=true");
  });

  it("resolves a username query through the indexed user resolver", async () => {
    const findDiscordUsers = vi.fn(async () => [
      { id: "555", username: "tyler", globalName: "Tyler", aliases: [], isBot: false, messageCount: 12, lastMessageAt: null, score: 90 }
    ]);
    const fetchDiscordUserAvatar = vi.fn(async () => ({
      avatarUrl: "https://cdn.discordapp.com/avatars/555/zzz.png",
      globalAvatarUrl: "https://cdn.discordapp.com/avatars/555/zzz.png",
      username: "tyler",
      globalName: "Tyler",
      isBot: false,
      hasCustomAvatar: true
    }));
    const ctx = {
      repo: {
        auditTool: vi.fn(async () => undefined),
        findDiscordUsers,
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"])
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      fetchDiscordUserAvatar
    } as unknown as ToolContext;

    const result = await getDiscordUserAvatar(ctx, { query: "tyler" });

    expect(findDiscordUsers).toHaveBeenCalledWith(expect.objectContaining({ query: "tyler", limit: 1 }));
    expect(fetchDiscordUserAvatar).toHaveBeenCalledWith({ guildId: "guild", userId: "555" });
    expect(result).toContain("https://cdn.discordapp.com/avatars/555/zzz.png");
  });

  it("reports no match when the user cannot be resolved", async () => {
    const findDiscordUsers = vi.fn(async () => []);
    const fetchDiscordUserAvatar = vi.fn(async () => null);
    const ctx = {
      repo: {
        auditTool: vi.fn(async () => undefined),
        findDiscordUsers,
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"])
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      fetchDiscordUserAvatar
    } as unknown as ToolContext;

    const result = await getDiscordUserAvatar(ctx, { query: "nobody" });

    expect(result).toContain("could not resolve");
    expect(fetchDiscordUserAvatar).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the discord client callback is unavailable", async () => {
    const ctx = {
      repo: {
        auditTool: vi.fn(async () => undefined),
        findDiscordUsers: vi.fn(async () => []),
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"])
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const result = await getDiscordUserAvatar(ctx, { query: "<@123>" });

    expect(result).toContain("cannot fetch a live avatar URL");
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

describe("getDeploymentStatus", () => {
  it("includes codegen sandbox lease counts", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      repo: {
        health: vi.fn(async () => ({ messages: 2, embeddings: 1, toolCalls: 3 })),
        getAgentTaskMetrics: vi.fn(async () => ({
          tasksByStatus: [{ status: "running", count: 1 }],
          agentTaskBacklog: [{ backend: "local-process-sandbox", status: "running", count: 1, oldestAgeSeconds: 125 }],
          sandboxRunsByStatus: [],
          codegenSandboxLeases: [
            { backend: "local-process-sandbox", status: "idle", count: 1 },
            { backend: "local-process-sandbox", status: "leased", count: 1 }
          ],
          codegenPhaseDurations: [],
          sandboxCacheEvents: []
        })),
        listAgentTasks: vi.fn(async () => []),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      config: { github: { repository: "example/discord-ai-agent", baseBranch: "main" } }
    } as unknown as ToolContext;

    const response = await getDeploymentStatus(ctx);

    expect(response).toContain("Codegen leases: local-process-sandbox.idle=1, local-process-sandbox.leased=1");
    expect(response).toContain("Agent backlog: local-process-sandbox.running=1 oldest=2m 5s");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDeploymentStatus" }));
  });

  it("calls out active stale code-update tasks", async () => {
    vi.setSystemTime(new Date("2026-07-01T12:30:00.000Z"));
    const auditTool = vi.fn(async () => undefined);
    const activeTask = {
      taskId: "task-stale",
      traceId: "trace-stale",
      guildId: "guild",
      channelId: "channel",
      status: "running",
      currentStep: "codex",
      title: "make codegen faster",
      requestedBy: "kartik",
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
      startedAt: new Date("2026-07-01T12:00:00.000Z"),
      progressUpdatedAt: new Date("2026-07-01T12:10:00.000Z"),
      updatedAt: new Date("2026-07-01T12:10:00.000Z")
    };
    const listAgentTasks = vi.fn(async (input: { statuses?: string[] }) => (input.statuses?.includes("running") ? [activeTask] : []));
    const ctx = {
      repo: {
        health: vi.fn(async () => ({ messages: 2, embeddings: 1, toolCalls: 3 })),
        getAgentTaskMetrics: vi.fn(async () => ({
          tasksByStatus: [{ status: "running", count: 1 }],
          agentTaskBacklog: [],
          sandboxRunsByStatus: [],
          codegenSandboxLeases: [],
          codegenPhaseDurations: [],
          sandboxCacheEvents: []
        })),
        listAgentTasks,
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      config: { github: { repository: "example/discord-ai-agent", baseBranch: "main" } }
    } as unknown as ToolContext;

    const response = await getDeploymentStatus(ctx);

    expect(response).toContain("Active code updates:");
    expect(response).toContain("`task-stale` | running | step=codex");
    expect(response).toContain("elapsed=30m 0s | idle=20m 0s | stale");
    expect(listAgentTasks).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["queued", "running"], limit: 5 }));
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.stringContaining("\"activeTasks\":1")
      })
    );
  });
});

describe("getAgentTaskStatus", () => {
  it("renders task progress events from the shared runtime-first event source", async () => {
    const auditTool = vi.fn(async () => undefined);
    const task = {
      taskId: "task-1",
      traceId: "trace-1",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      threadKey: "discord:guild:channel",
      discordResponseChannelId: "channel",
      discordResponseMessageId: "message-1",
      retriedFromTaskId: null,
      taskType: "code_update",
      title: "Improve runtime status",
      request: "make task status use runtime events",
      requestedBy: "kartik",
      status: "running",
      backend: "local-process-sandbox",
      currentStep: "opencode_round_finished",
      statusMessage: "OpenCode round 1 finished.",
      branchName: null,
      prUrl: null,
      draft: null,
      verifyPassed: null,
      error: null,
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
      startedAt: new Date("2026-07-01T12:00:01.000Z"),
      cancelledAt: null,
      completedAt: null,
      notifiedAt: null,
      notificationError: null,
      progressUpdatedAt: new Date("2026-07-01T12:01:00.000Z"),
      lastRenderedSignature: null,
      lastRenderedAt: null,
      terminalRenderedAt: null,
      updatedAt: new Date("2026-07-01T12:01:00.000Z")
    };
    const getTaskProgressEventsForTask = vi.fn(async () => [
      {
        id: 2,
        taskId: "task-1",
        traceId: "trace-1",
        eventName: "agent.task.progress",
        level: "info",
        summary: "Runtime event won.",
        metadata: { taskId: "task-1", step: "opencode_round_finished" },
        createdAt: new Date("2026-07-01T12:01:00.000Z")
      }
    ]);
    const ctx = {
      repo: {
        getAgentTask: vi.fn(async () => task),
        getTaskProgressEventsForTask,
        getSandboxCommandEvents: vi.fn(async () => []),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await getAgentTaskStatus(ctx, { taskId: "task-1", limit: 3 });

    expect(response).toContain("agent.task.progress task=task-1 - Runtime event won.");
    expect(getTaskProgressEventsForTask).toHaveBeenCalledWith({ taskId: "task-1", limit: 3 });
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "getAgentTaskStatus",
        resultSummary: expect.stringContaining("\"events\":1")
      })
    );
  });

  it("includes GitHub PR and CI check status when a task has a pull request", async () => {
    const auditTool = vi.fn(async () => undefined);
    const task = {
      taskId: "task-1",
      traceId: "trace-1",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      threadKey: "discord:guild:channel",
      discordResponseChannelId: "channel",
      discordResponseMessageId: "message-1",
      retriedFromTaskId: null,
      taskType: "code_update",
      title: "Improve runtime status",
      request: "make task status include CI",
      requestedBy: "kartik",
      status: "succeeded",
      backend: "kubernetes",
      currentStep: "done",
      statusMessage: "Opened pull request.",
      branchName: "ai/runtime-status",
      prUrl: "https://github.com/example/discord-ai-agent/pull/42",
      draft: false,
      verifyPassed: null,
      error: null,
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
      startedAt: new Date("2026-07-01T12:00:01.000Z"),
      cancelledAt: null,
      completedAt: new Date("2026-07-01T12:04:00.000Z"),
      notifiedAt: null,
      notificationError: null,
      progressUpdatedAt: new Date("2026-07-01T12:04:00.000Z"),
      lastRenderedSignature: null,
      lastRenderedAt: null,
      terminalRenderedAt: null,
      updatedAt: new Date("2026-07-01T12:04:00.000Z")
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/repos/example/discord-ai-agent/pulls/42")) {
        return jsonResponse({
          number: 42,
          title: "Improve runtime status",
          state: "open",
          draft: false,
          head: { ref: "ai/runtime-status", sha: "abcdef1234567890" }
        });
      }
      if (url.endsWith("/repos/example/discord-ai-agent/commits/abcdef1234567890/check-runs?per_page=50")) {
        return jsonResponse({
          total_count: 2,
          check_runs: [
            {
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/example/discord-ai-agent/actions/runs/1",
              output: { title: "Tests failed" }
            },
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/example/discord-ai-agent/actions/runs/2"
            }
          ]
        });
      }
      if (url.endsWith("/repos/example/discord-ai-agent/commits/abcdef1234567890/status")) {
        return jsonResponse({
          state: "failure",
          statuses: [{ context: "ci/legacy", state: "failure", target_url: "https://ci.example/failure" }]
        });
      }
      throw new Error(`Unexpected GitHub URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      repo: {
        getAgentTask: vi.fn(async () => task),
        getTaskProgressEventsForTask: vi.fn(async () => []),
        getSandboxCommandEvents: vi.fn(async () => []),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      config: {
        github: {
          token: "github-token",
          repository: "example/discord-ai-agent",
          baseBranch: "main"
        }
      }
    } as unknown as ToolContext;

    const response = await getAgentTaskStatus(ctx, { taskId: "task-1", limit: 3 });

    expect(response).toContain("GitHub PR status:");
    expect(response).toContain("PR #42: open head=abcdef1 branch=ai/runtime-status");
    expect(response).toContain("Checks: failure=1, success=1");
    expect(response).toContain("test (failure) https://github.com/example/discord-ai-agent/actions/runs/1 - Tests failed");
    expect(response).toContain("Next action: for debugging or fixing, call runCodingAgent so the sandbox can inspect logs with gh CLI");
    expect(response).toContain("Commit status: failure");
    expect(response).toContain("ci/legacy (failure) https://ci.example/failure");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/example/discord-ai-agent/pulls/42",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer github-token"
        })
      })
    );
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "getAgentTaskStatus",
        resultSummary: expect.stringContaining("\"pullRequestStatus\":true")
      })
    );
  });
});

function jsonResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => value),
    text: vi.fn(async () => JSON.stringify(value))
  };
}

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
        getTaskProgressEvents: vi.fn(async () => [
          {
            id: 1,
            taskId: "task-1",
            traceId: "trace-1",
            eventName: "agent.task.progress",
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
            step: "scan",
            command: "npm run scan:release",
            exitCode: 1,
            outputTail: "",
            errorTail: "test failure",
            durationMs: 123,
            createdAt: new Date("2026-01-01T00:00:04Z")
          }
        ]),
        getProcessRun: vi.fn(async () => undefined),
        getAgentTask: vi.fn(async () => undefined),
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
    expect(response).toContain("agent.task.progress task=task-1");
    expect(response).toContain("Sandbox commands:");
    expect(response).toContain("npm run scan:release");
    expect(response).toContain("searchDiscordHistory");
    expect(ctx.repo.getTraceEvents).toHaveBeenCalledWith({
      guildId: "guild",
      visibleChannelIds: ["channel"],
      traceId: "trace-1",
      limit: 10
    });
    expect(ctx.repo.getTaskProgressEvents).toHaveBeenCalledWith({
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

  it("includes normalized run diagnostics when a visible run is referenced", async () => {
    const auditTool = vi.fn(async () => undefined);
    const run = {
      runId: "run-1",
      traceId: "1234567890123450031",
      kind: "codegen",
      status: "failed",
      title: "Investigate timeout",
      summary: "Codegen failed.",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      messageId: "1234567890123450031",
      requester: "kartik",
      source: "agent_task",
      metadata: {
        failureDiagnosis: {
          category: "command_failed",
          summary: "The verification command failed.",
          nextAction: "Inspect the failing command output."
        }
      },
      links: { run: "https://tasks.example/runs/run-1" },
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:15:00Z"),
      updatedAt: new Date("2026-01-01T00:15:00Z")
    };
    const ctx = {
      repo: {
        findProcessRunByDiscordMessageId: vi.fn(async () => run),
        findAgentTaskByDiscordMessageId: vi.fn(async () => undefined),
        getProcessRun: vi.fn(async (runId: string) => (runId === "run-1" ? run : undefined)),
        getAgentTask: vi.fn(async (taskId: string) =>
          taskId === "run-1"
            ? {
                taskId: "run-1",
                traceId: "1234567890123450031",
                guildId: "guild",
                channelId: "channel",
                userId: "user",
                requestedBy: "kartik",
                title: "Investigate timeout",
                request: "fix the timeout",
                status: "failed",
                statusMessage: "Codegen failed.",
                error: "verification failed",
                currentStep: "verify",
                branchName: "ai/investigate-timeout",
                prUrl: null,
                draft: true,
                verifyPassed: false,
                notificationError: null,
                retriedFromTaskId: null,
                backend: "local-process",
                createdAt: new Date("2026-01-01T00:00:00Z"),
                startedAt: new Date("2026-01-01T00:00:00Z"),
                completedAt: new Date("2026-01-01T00:15:00Z"),
                updatedAt: new Date("2026-01-01T00:15:00Z"),
                progressUpdatedAt: new Date("2026-01-01T00:14:59Z")
              }
            : undefined
        ),
        getProcessRunSpans: vi.fn(async () => [
          {
            id: 1,
            runId: "run-1",
            spanId: "codex",
            parentSpanId: null,
            name: "opencode_attempt_1",
            status: "failed",
            metadata: {},
            startedAt: new Date("2026-01-01T00:01:00Z"),
            completedAt: new Date("2026-01-01T00:14:00Z"),
            durationMs: 780_000
          }
        ]),
        getProcessRunEvents: vi.fn(async () => [
          {
            id: 1,
            runId: "run-1",
            traceId: "1234567890123450031",
            level: "error",
            eventName: "task.failed",
            summary: "verification failed",
            metadata: {},
            durationMs: null,
            createdAt: new Date("2026-01-01T00:15:00Z")
          }
        ]),
        getProcessRunArtifacts: vi.fn(async () => []),
        getProcessRunArtifact: vi.fn(async () => undefined),
        getTaskProgressEventsForTask: vi.fn(async () => []),
        getSandboxCommandEventsForTask: vi.fn(async () => [
          {
            id: 1,
            taskId: "task-1",
            sandboxRunId: "sandbox-1",
            step: "verify",
            command: "npm run verify",
            exitCode: 1,
            outputTail: "",
            errorTail: "test failed",
            durationMs: 1234,
            createdAt: new Date("2026-01-01T00:14:59Z")
          }
        ]),
        getSandboxRunsForTask: vi.fn(async () => []),
        getTraceEventsForTrace: vi.fn(async () => []),
        getAgentRuntimeEventsForTrace: vi.fn(async () => []),
        getAgentRuntimeMessagesForTrace: vi.fn(async () => []),
        getToolAuditLogsForTrace: vi.fn(async () => []),
        listProcessRunsForTrace: vi.fn(async () => [run]),
        listAgentTasksForTrace: vi.fn(async () => []),
        getTraceEvents: vi.fn(async () => []),
        getTaskProgressEvents: vi.fn(async () => []),
        getSandboxCommandEvents: vi.fn(async () => []),
        getToolAuditLogs: vi.fn(async () => []),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await inspectAgentLogs(ctx, {
      traceId: "https://discord.com/channels/guild/channel/1234567890123450031",
      limit: 10
    });

    expect(response).toContain("codegen run run-1");
    expect(response).toContain("Failure diagnosis: The verification command failed.");
    expect(response).toContain("Most time was spent in opencode_attempt_1");
    expect(response).toContain("Terminal tail");
    expect(response).toContain("npm run verify");
    expect(ctx.repo.findProcessRunByDiscordMessageId).toHaveBeenCalledWith("1234567890123450031");
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.stringContaining("\"normalizedRun\":\"run-1\"")
      })
    );
  });

  it("does not include normalized run diagnostics for an invisible run", async () => {
    const auditTool = vi.fn(async () => undefined);
    const hiddenRun = {
      runId: "run-hidden",
      traceId: "1234567890123450032",
      kind: "discord",
      status: "failed",
      title: "Private channel prompt",
      summary: "private failure",
      guildId: "guild",
      channelId: "private-channel",
      userId: "user",
      messageId: "1234567890123450032",
      requester: "kartik",
      source: "discord",
      metadata: {},
      links: {},
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:00:01Z"),
      updatedAt: new Date("2026-01-01T00:00:01Z")
    };
    const ctx = {
      repo: {
        findProcessRunByDiscordMessageId: vi.fn(async () => hiddenRun),
        findAgentTaskByDiscordMessageId: vi.fn(async () => undefined),
        getProcessRun: vi.fn(async () => hiddenRun),
        getAgentTask: vi.fn(async () => undefined),
        getProcessRunSpans: vi.fn(async () => []),
        getProcessRunEvents: vi.fn(async () => []),
        getProcessRunArtifacts: vi.fn(async () => []),
        getTaskProgressEventsForTask: vi.fn(async () => []),
        getSandboxCommandEventsForTask: vi.fn(async () => []),
        getSandboxRunsForTask: vi.fn(async () => []),
        getTraceEventsForTrace: vi.fn(async () => []),
        getAgentRuntimeEventsForTrace: vi.fn(async () => []),
        getAgentRuntimeMessagesForTrace: vi.fn(async () => []),
        getToolAuditLogsForTrace: vi.fn(async () => []),
        listProcessRunsForTrace: vi.fn(async () => []),
        listAgentTasksForTrace: vi.fn(async () => []),
        getTraceEvents: vi.fn(async () => []),
        getTaskProgressEvents: vi.fn(async () => []),
        getSandboxCommandEvents: vi.fn(async () => []),
        getToolAuditLogs: vi.fn(async () => []),
        auditTool
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"]
    } as unknown as ToolContext;

    const response = await inspectAgentLogs(ctx, { traceId: "1234567890123450032" });

    expect(response).toBe("No Discord AI Agent trace or tool logs matched traceId=1234567890123450032.");
    expect(response).not.toContain("Private channel prompt");
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.not.stringContaining("run-hidden")
      })
    );
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
      config: { maxThreadSummaryMessages: 80, openRouter: { utilityModel: "main-chat-fallback" } }
    } as unknown as ToolContext;

    await expect(summarizeCurrentThread(ctx)).resolves.toBe("Nachos won.");
    expect(ctx.repo.recentMessages).toHaveBeenCalledWith({
      guildId: "guild",
      channelId: "channel",
      limit: 80
    });
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "main-chat-fallback",
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
