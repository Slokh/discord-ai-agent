import { describe, expect, it, vi } from "vitest";
import { handleAgentRequest } from "../../src/agent/router.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("agent router", () => {
  it("grounds first-person requests to the current Discord requester", async () => {
    const chat = vi.fn(async () => ({
      content: "ok",
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "requester-id",
      userDisplayName: "Casey",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          role: "user",
          authorId: "someone-else",
          authorDisplayName: "Luke",
          content: "something from earlier",
          metadata: {},
          createdAt: new Date()
        }
      ]
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "when is my birthday");

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Current Discord requester: Casey (user ID requester-id)")
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("First-person pronouns in the latest user request")
          })
        ])
      })
    );
  });

  it("lets the model route status requests to reportStatus", async () => {
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 1, embeddings: 1, toolCalls: 0 })),
        getCrawlStatus: vi.fn(async () => [{ status: "complete", channels: 1, messages: 1 }]),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            estimatedCostUsd: 0.001,
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 1",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      mentionedUserIds: []
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "status");
    expect(response.content).toMatch(/Messages indexed: 1/);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "reportStatus" }) }),
          expect.objectContaining({ type: "openrouter:web_search" })
        ])
      })
    );
  });

  it("mirrors model-selected tool turns into the durable agent runtime session", async () => {
    const appendMessage = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 1, embeddings: 1, toolCalls: 0 })),
        getCrawlStatus: vi.fn(async () => [{ status: "complete", channels: 1, messages: 1 }]),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      agentRuntime: { appendMessage },
      agentRuntimeSession: { sessionId: "agent-session-1" },
      agentRuntimeExecutionId: "agent-execution-1",
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            estimatedCostUsd: 0.001,
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 1",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      requestId: "prompt-message-1"
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "status");

    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        messageId: "agent-transcript-prompt-message-1-assistant-round-1",
        clientMessageId: "prompt-message-1:transcript:assistant-round-1",
        role: "assistant",
        parts: [
          expect.objectContaining({
            type: "assistant_tool_calls",
            toolCalls: [
              expect.objectContaining({
                id: "call-1",
                name: "reportStatus",
                arguments: {},
                argumentsText: "{}"
              })
            ]
          })
        ],
        metadata: expect.objectContaining({
          source: "agent.router",
          promptMessageId: "prompt-message-1",
          executionId: "agent-execution-1",
          round: 1,
          model: "router-model"
        })
      })
    );
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        messageId: "agent-transcript-prompt-message-1-tool-call-1",
        clientMessageId: "prompt-message-1:transcript:tool-call-1",
        role: "tool",
        parts: [
          expect.objectContaining({
            type: "tool_result",
            toolCallId: "call-1",
            toolName: "reportStatus",
            content: expect.stringContaining("Messages indexed: 1")
          })
        ],
        metadata: expect.objectContaining({
          source: "agent.router",
          promptMessageId: "prompt-message-1",
          executionId: "agent-execution-1",
          round: 1,
          toolName: "reportStatus"
        })
      })
    );
  });

  it.each(["what can you do", "what can you do?", "tools?", "help"])(
    "lets the model route natural-language tool-list request %j",
    async (request) => {
      const ctx = {
        config: { maxReplyChars: 1800 },
        repo: {
          health: vi.fn(),
          getCrawlStatus: vi.fn(),
          auditTool: vi.fn(async () => undefined)
        },
        openRouter: {
          chat: vi
            .fn()
            .mockResolvedValueOnce({
              content: "",
              model: "router-model",
              raw: {},
              toolCalls: [{ id: "call-1", name: "listTools", argumentsText: "{}" }]
            })
            .mockResolvedValueOnce({
              content: "Discord AI Agent tools:\n- searchDiscordHistory: Search permission-filtered indexed Discord history.",
              model: "chat-model",
              raw: {},
              toolCalls: []
            })
        },
        github: {},
        guildId: "g",
        channelId: "c",
        userId: "u",
        userDisplayName: "User",
        visibleChannelIds: ["c"]
      } as unknown as ToolContext;

      const response = await handleAgentRequest(ctx, request);

      expect(response.content).toContain("Discord AI Agent tools:");
      expect(response.content).toContain("searchDiscordHistory");
      expect(ctx.repo.health).not.toHaveBeenCalled();
      expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    }
  );

  it("lets the model accept conversational status requests with punctuation", async () => {
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 3, embeddings: 2, toolCalls: 1 })),
        getCrawlStatus: vi.fn(async () => []),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 3",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "health check?");

    expect(response.content).toContain("Messages indexed: 3");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
  });

  it("lets the model select a registered read-only tool for non-command phrasing", async () => {
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 2, embeddings: 1, toolCalls: 4, estimatedCostUsd: 0.02 })),
        getCrawlStatus: vi.fn(async () => [{ status: "running", channels: 3, messages: 50 }]),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            estimatedCostUsd: 0.001,
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 2",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how's the index looking overall");

    expect(response.content).toContain("Messages indexed: 2");
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.any(Array) }));
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
          expect.objectContaining({ role: "tool", name: "reportStatus", content: expect.stringContaining("Messages indexed: 2") })
        ])
      })
    );
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "modelToolRouter",
        resultSummary: "reportStatus",
        model: "router-model"
      })
    );
  });

  it("lets the model route recurring channel-topic requests to semantic topic analysis", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["stonks"]),
        discordChannelTopicCandidates: vi.fn(async () => [
          channelTopicCandidate("startup jobs and interview loops", [1, 0]),
          channelTopicCandidate("job offers and workplace complaints", [0.95, 0.05]),
          channelTopicCandidate("work drama and recruiting updates", [0.9, 0.1]),
          channelTopicCandidate("nvda earnings and market close", [0, 1]),
          channelTopicCandidate("stocks are ripping again", [0.05, 0.95]),
          channelTopicCandidate("portfolio updates and trading chat", [0.1, 0.9])
        ]),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "getDiscordChannelTopics", argumentsText: JSON.stringify({ channelLimit: 2, topicsPerChannel: 2 }) }]
          })
          .mockResolvedValueOnce({
            content: "#stonks: job hunting and market talk",
            model: "topic-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "Stonks mostly cycles between job hunting and market talk.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["stonks"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what are the main recurring topics in each channel");

    expect(response.content).toBe("Stonks mostly cycles between job hunting and market talk.");
    expect(ctx.repo.discordChannelTopicCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["stonks"],
        channelLimit: 2,
        samplesPerChannel: 90
      })
    );
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "getDiscordChannelTopics",
            content: expect.stringContaining("#stonks: job hunting and market talk")
          }),
          expect.objectContaining({
            role: "tool",
            name: "getDiscordChannelTopics",
            content: expect.stringContaining("Discord channel topics summary:")
          })
        ])
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "modelToolRouter", resultSummary: "getDiscordChannelTopics" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordChannelTopics" }));
  });

  it("lets the model route broad activity recaps to history summarization", async () => {
    const auditTool = vi.fn(async () => undefined);
    const sampleMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z")
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        sampleMessagesFromChannels,
        recentMessagesFromChannels: vi.fn(async () => []),
        keywordSearch: vi.fn(async () => []),
        vectorSearch: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "summarizeDiscordHistory",
                argumentsText: JSON.stringify({ question: "what has tyler been up to recently?", authorIds: ["tyler-id"], sampleLimit: 60 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays mentioned moving in with his girlfriend in May 2026.",
            model: "summary-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "@taylorplays mentioned moving in with his girlfriend in May 2026.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toContain("moving in with his girlfriend");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(sampleMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c"],
        authorIds: ["tyler-id"],
        limit: 60
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "summarizeDiscordHistory" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "composeDiscordHistorySummary", model: "summary-model" }));
  });

  it("keeps fallback answers compact when final synthesis fails", async () => {
    const auditTool = vi.fn(async () => undefined);
    const result = agentSearchResult({
      messageId: "rare-message",
      authorId: "rare-user-id",
      authorUsername: "rare_guest_0001",
      normalizedContent: "Wordle 213 4/6",
      createdAt: new Date("2022-01-18T00:00:00.000Z"),
      link: "https://discord.com/channels/g/c/rare-message"
    });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: { embeddingModel: "test/embed" } },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["c"]),
        keywordSearch: vi.fn(async () => [result]),
        vectorSearch: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "rare_guest_0001", limit: 5 }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "empty-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "",
            model: "empty-final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "link to the message from rare_guest_0001");

    expect(response.content).toContain("@rare_guest_0001");
    expect(response.content).not.toContain("https://discord.com/channels/g/c/rare-message");
    expect(response.content).toContain("Weak matches");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "searchDiscordHistory" }));
  });

  it("uses representative history evidence when summary and final models return empty content", async () => {
    const auditTool = vi.fn(async () => undefined);
    const sampleMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z"),
        score: 42
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        sampleMessagesFromChannels,
        recentMessagesFromChannels: vi.fn(async () => []),
        keywordSearch: vi.fn(async () => []),
        vectorSearch: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "summarizeDiscordHistory",
                argumentsText: JSON.stringify({ question: "what has tyler been up to recently?", authorIds: ["tyler-id"] })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "summary-model",
            raw: {},
            finishReason: "length",
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({ content: "", model: "empty-final-model", raw: {}, toolCalls: [] })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toContain("Representative Discord history");
    expect(response.content).toContain("Moving in with girlfriend next week");
    expect(response.content).not.toContain("I found relevant evidence, but I could not compose");
    expect(response.content).not.toBe("Done.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(4);
  });

  it("allows the model to refine history searches within a turn", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [agentSearchResult()]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job hunting" }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "retry-model",
            raw: {},
            toolCalls: [{ id: "call-2", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "interview" }) }]
          })
          .mockResolvedValueOnce({
            content: "People mostly shared job-search updates and interview nerves.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what have people said about job hunting or interviewing?");

    expect(response.content).toBe("People mostly shared job-search updates and interview nerves.");
    expect(keywordSearch).toHaveBeenCalledTimes(2);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", name: "searchDiscordHistory", content: expect.stringContaining("Effective query: job hunting") }),
          expect.objectContaining({ role: "tool", name: "searchDiscordHistory", content: expect.stringContaining("Effective query: interview") })
        ])
      })
    );
    expect(JSON.stringify((ctx.openRouter.chat as any).mock.calls[2][0].messages)).not.toContain("Skipped redundant history search");
    expect(auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
  });

  it("lets the model answer after message context evidence", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [
      agentSearchResult({
        normalizedContent: "Got the job",
        createdAt: new Date("2025-08-22T12:00:00.000Z"),
        link: "https://discord.com/channels/111111111111111111/222222222222222222/123456789012345678"
      })
    ]);
    const messageContext = vi.fn(async () => [
      agentSearchResult({
        messageId: "123456789012345678",
        normalizedContent: "Got the job",
        createdAt: new Date("2025-08-22T12:00:00.000Z"),
        link: "https://discord.com/channels/111111111111111111/222222222222222222/123456789012345678"
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        messageContext,
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              { id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "changed jobs", limit: 10 }) },
              { id: "call-2", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "got the job", limit: 10 }) }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "context-model",
            raw: {},
            toolCalls: [
              {
                id: "call-3",
                name: "getDiscordMessageContext",
                argumentsText: JSON.stringify({
                  messageIdOrUrl: "https://discord.com/channels/111111111111111111/222222222222222222/123456789012345678"
                })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Yeah, @alice said they got the job.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toBe("Yeah, @alice said they got the job.");
    expect(keywordSearch).toHaveBeenCalledTimes(2);
    expect(messageContext).toHaveBeenCalledTimes(1);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          name: "getDiscordMessageContext",
          content: expect.stringContaining("Got the job")
        })
      ])
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordMessageContext" }));
    expect(auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "tool_round_limit" }));
  });

  it("skips exact duplicate local tool calls and synthesizes from the first result", async () => {
    const auditTool = vi.fn(async () => undefined);
    const recentMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Wordle 1,832 4/6",
        createdAt: new Date("2026-06-24T12:00:00.000Z")
      })
    ]);
    const recentArgs = JSON.stringify({ authorIds: ["tyler-id"], limit: 20 });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        recentMessagesFromChannels,
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "getRecentDiscordMessages", argumentsText: recentArgs }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "retry-model",
            raw: {},
            toolCalls: [{ id: "call-2", name: "getRecentDiscordMessages", argumentsText: recentArgs }]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays has mostly been posting Wordle updates recently.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toBe("@taylorplays has mostly been posting Wordle updates recently.");
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(1);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system", content: expect.stringContaining("Write one natural Discord reply") }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("Wordle 1,832") })
        ])
      })
    );
    expect((ctx.openRouter.chat as any).mock.calls[2][0].messages[1].content).not.toContain("Skipped redundant getRecentDiscordMessages");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
  });

  it("preserves empty history-search queries for broad filtered scans", async () => {
    const auditTool = vi.fn(async () => undefined);
    const recentMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z")
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        recentMessagesFromChannels,
        keywordSearch: vi.fn(async () => {
          throw new Error("empty query should use recent-message scan, not keyword search");
        }),
        vectorSearch: vi.fn(async () => {
          throw new Error("empty query should use recent-message scan, not vector search");
        }),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "", authorIds: ["tyler-id"], dateFrom: "2026-05-01", limit: 30 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays mentioned moving in with his girlfriend in May 2026.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toBe("@taylorplays mentioned moving in with his girlfriend in May 2026.");
    expect(recentMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c"],
        authorIds: ["tyler-id"],
        dateFrom: new Date("2026-05-01T00:00:00.000Z"),
        limit: 25
      })
    );
    expect(ctx.repo.keywordSearch).not.toHaveBeenCalled();
    expect(ctx.repo.vectorSearch).not.toHaveBeenCalled();
  });

  it("passes about-user filters from model-selected history searches", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [
      agentSearchResult({
        authorId: "friend-id",
        authorUsername: "friend",
        normalizedContent: "happy birthday casey"
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        getDiscordUserReferenceTerms: vi.fn(async () => [
          {
            userId: "casey-id",
            username: "caseyuser",
            globalName: "Casey",
            aliases: ["case"],
            terms: ["@user:casey-id", "caseyuser", "casey", "case"]
          }
        ]),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "birthday", aboutUserIds: ["casey-id"], limit: 10 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Looks like people have wished you happy birthday.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "when is my birthday?");

    expect(response.content).toBe("Looks like people have wished you happy birthday.");
    expect(ctx.repo.getDiscordUserReferenceTerms).toHaveBeenCalledWith({ guildId: "g", userIds: ["casey-id"] });
    expect(keywordSearch).toHaveBeenCalledWith(expect.objectContaining({ aboutUserTerms: ["@user:casey-id", "caseyuser", "casey", "case"] }));
  });

  it("allows broad history scans after narrower keyword searches with the same filters", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Wordle 1,834 4/6"
      })
    ]);
    const recentMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z")
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        recentMessagesFromChannels,
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "recent activity", authorIds: ["tyler-id"], dateFrom: "2026-05-01", limit: 15 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-2",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "", authorIds: ["tyler-id"], dateFrom: "2026-05-01", limit: 20 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays had puzzle chatter, and also mentioned moving in with his girlfriend in May 2026.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toContain("moving in with his girlfriend");
    expect(keywordSearch).toHaveBeenCalledTimes(1);
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(1);
    expect(auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
  });

  it("synthesizes a final answer instead of dumping raw tool output at the tool round limit", async () => {
    const auditTool = vi.fn(async () => undefined);
    const recentMessagesFromChannels = vi.fn(async () => [agentSearchResult()]);
    const toolCallForRound = (round: number) => ({
      content: "",
      model: `tool-model-${round}`,
      raw: {},
      toolCalls: [
        {
          id: `call-${round}`,
          name: "getRecentDiscordMessages",
          argumentsText: JSON.stringify({ limit: 10 + round })
        }
      ]
    });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        recentMessagesFromChannels,
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce(toolCallForRound(1))
          .mockResolvedValueOnce(toolCallForRound(2))
          .mockResolvedValueOnce(toolCallForRound(3))
          .mockResolvedValueOnce(toolCallForRound(4))
          .mockResolvedValueOnce({
            content: "The useful summary is that people mentioned job changes in 2025.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toBe("The useful summary is that people mentioned job changes in 2025.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(5);
    expect((ctx.openRouter.chat as any).mock.calls[4][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system", content: expect.stringContaining("Write one natural Discord reply") }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("@alice channel=c") })
        ])
      })
    );
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(4);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "tool_round_limit" }));
  });

  it("synthesizes a final answer when the model returns empty content after tool evidence", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch: vi.fn(async () => [agentSearchResult()]),
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "tool-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job changes" }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "empty-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "People mentioned job changes in 2025.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toBe("People mentioned job changes in 2025.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
  });

  it("falls back to compact evidence bullets when forced final synthesis is empty", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch: vi.fn(async () => [agentSearchResult({ createdAt: new Date("2025-08-22T09:02:38.554Z"), normalizedContent: "Got the job" })]),
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "tool-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job changes", dateFrom: "2025-01-01" }) }]
          })
          .mockResolvedValueOnce({ content: "", model: "empty-model", raw: {}, toolCalls: [] })
          .mockResolvedValueOnce({ content: "", model: "empty-final-model", raw: {}, toolCalls: [] })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toContain("No solid answer from the indexed messages");
    expect(response.content).toContain("@alice:");
    expect(response.content).toContain("Got the job");
    expect(response.content).not.toContain("@alice on 2025-08-22");
    expect(response.content).not.toContain("Discord search evidence:");
  });

  it("keeps ordinary questions in normal chat instead of forcing history search", async () => {
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({
          content: "A haiku is a compact three-line poem.",
          model: "chat-model",
          raw: {},
          toolCalls: []
        }))
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what is a haiku?");

    expect(response.content).toBe("A haiku is a compact three-line poem.");
    expect(ctx.repo.getVisibleIndexedChannelIds).not.toHaveBeenCalled();
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "chat", model: "chat-model" }));
  });

  it("recovers when a hosted OpenRouter tool call leaks as text", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              "<tool_call>openrouter_web_fetch<arg_key>url</arg_key><arg_value>https://example.com/game</arg_value></tool_call>",
            model: "tool-leak-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "Check your rank from the game's ranked mode screen.",
            model: "recovery-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how can i see my rank?");

    expect(response.content).toBe("Check your rank from the game's ranked mode screen.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect((ctx.openRouter.chat as any).mock.calls[1][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_fetch" })]));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("passes prior channel session memory to the model for follow-up continuity", async () => {
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({
          content: "Earlier I generated an image for a wizard eating nachos.",
          model: "chat-model",
          raw: {},
          toolCalls: []
        }))
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          id: 1,
          threadKey: "discord:g:c",
          discordMessageId: "m1",
          role: "user",
          authorId: "u",
          authorDisplayName: "Kartik",
          content: "make an image of a wizard eating nachos",
          parts: [],
          metadata: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z")
        },
        {
          id: 2,
          threadKey: "discord:g:c",
          discordMessageId: null,
          role: "tool",
          authorId: "bot",
          authorDisplayName: "ai",
          content: "Generated image for: a wizard eating nachos",
          parts: [],
          metadata: { toolName: "generateImage" },
          createdAt: new Date("2026-01-01T00:00:01.000Z")
        },
        {
          id: 3,
          threadKey: "discord:g:c",
          discordMessageId: "m2",
          role: "assistant",
          authorId: "bot",
          authorDisplayName: "ai",
          content: "Generated image for: a wizard eating nachos",
          parts: [],
          metadata: {},
          createdAt: new Date("2026-01-01T00:00:02.000Z")
        }
      ]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what image did we generate earlier?");

    expect(response.content).toContain("wizard eating nachos");
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Kartik: make an image of a wizard eating nachos" }),
          expect.objectContaining({
            role: "assistant",
            content: "[Earlier generateImage result; not authoritative unless refreshed] Generated image for: a wizard eating nachos"
          }),
          expect.objectContaining({
            role: "assistant",
            content: "[Earlier Discord AI Agent reply; not authoritative for Discord facts] Generated image for: a wizard eating nachos"
          }),
          expect.objectContaining({ role: "user", content: "what image did we generate earlier?" })
        ])
      })
    );
  });

  it("passes Discord reply parent context to the model for follow-up continuity", async () => {
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({
          content: "Yes, merge that PR.",
          model: "chat-model",
          raw: {},
          toolCalls: []
        }))
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      replyContext: {
        messageId: "parent-1",
        channelId: "c",
        guildId: "g",
        authorId: "alice",
        authorDisplayName: "Alice",
        authorIsBot: false,
        content: "should I merge this PR?",
        attachmentSummaries: ["diff.png image/png 12000 bytes"],
        createdAt: "2026-06-29T16:00:00.000Z",
        url: "https://discord.com/channels/g/c/parent-1",
        rootMessageId: "parent-1",
        chain: [
          {
            messageId: "parent-1",
            channelId: "c",
            guildId: "g",
            authorId: "alice",
            authorDisplayName: "Alice",
            authorIsBot: false,
            content: "should I merge this PR?",
            attachmentSummaries: ["diff.png image/png 12000 bytes"],
            createdAt: "2026-06-29T16:00:00.000Z",
            url: "https://discord.com/channels/g/c/parent-1"
          }
        ]
      }
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "yes");

    expect(response.content).toBe("Yes, merge that PR.");
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("The current user message is a Discord reply. Use this oldest-to-newest parent chain")
          }),
          expect.objectContaining({ role: "system", content: expect.stringContaining("Author: Alice") }),
          expect.objectContaining({ role: "system", content: expect.stringContaining("Content: should I merge this PR?") }),
          expect.objectContaining({ role: "system", content: expect.stringContaining("Attachments: diff.png image/png 12000 bytes") }),
          expect.objectContaining({ role: "user", content: "yes" })
        ])
      })
    );
  });

  it("executes model-selected skill drafts through the structured tool boundary", async () => {
    const upsertDatabaseSkill = vi.fn(async (input: { name: string; content: string }) => ({
      name: input.name,
      content: input.content,
      source: "database",
      version: 1
    }));
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: {} },
      repo: {
        listEnabledDatabaseSkills: vi.fn(async () => []),
        upsertDatabaseSkill,
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "createSkillDraft",
                argumentsText: JSON.stringify({ skillName: "movie-night", instruction: "movie night is on Fridays" })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Saved that as a private skill.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what is movie night?");

    expect(response.content).toBe("Saved that as a private skill.");
    expect(upsertDatabaseSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "movie-night", request: "movie night is on Fridays" }));
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "createSkillDraft" }));
  });

  it("executes model-selected undo requests through the local undo tool", async () => {
    const deleteDiscordMessageIds = vi.fn(async () => 1);
    const deleteMostRecentConversationTurns = vi.fn(async () => ({
      deletedTurns: 1,
      deletedRows: 2,
      assistantDiscordMessageIds: ["reply-1"]
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        deleteMostRecentConversationTurns,
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "undoConversationTurns", argumentsText: JSON.stringify({ count: 1 }) }]
          })
          .mockResolvedValueOnce({
            content: "Undone.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      deleteDiscordMessageIds
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "undo that");

    expect(response.content).toBe("Undone.");
    expect(deleteMostRecentConversationTurns).toHaveBeenCalledWith({ threadKey: "discord:g:c", count: 1 });
    expect(deleteDiscordMessageIds).toHaveBeenCalledWith(["reply-1"]);
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "undoConversationTurns" }));
  });

  it("executes model-selected update requests as coding PR jobs", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-calendar-integration"
    }));
    const ctx = {
      config: { maxReplyChars: 1800, github: {} },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "runCodingAgent",
                argumentsText: JSON.stringify({ request: "add a calendar integration", title: "Add calendar support" })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Opened a review PR.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how should we track events?");

    expect(response.content).toBe(
      "Working on it...\n\nI’ll update this message with progress and the PR link when it’s ready.\nTask ID: `task-calendar-integration`."
    );
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add calendar support",
        request: "add a calendar integration",
        requestedBy: "User (u)",
        taskType: "code_update",
        threadKey: "discord:g:c",
        discordResponseChannelId: "c",
        discordResponseMessageId: "reply-1"
      })
    );
    expect(ctx.updateStatus).toHaveBeenCalledWith("Working on it...\n\nI’ll edit this message with progress and the PR link when it’s ready.");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "runCodingAgent" }));
  });

  it("creates model-selected code-update jobs through the current agent runtime session when available", async () => {
    const enqueueAgentTask = vi.fn(async (job: { taskId?: string }) => ({
      jobId: "job-1",
      taskId: job.taskId ?? "task-runtime-first"
    }));
    const agentRuntime = {
      appendMessage: vi.fn(async () => undefined),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => undefined)
    };
    const upsertAgentTaskQueued = vi.fn(async () => undefined);
    const ctx = {
      config: {
        maxReplyChars: 1800,
        github: {},
        openRouter: { codegenModel: "z-ai/glm-5.2" },
        execution: { codegenBackend: "local-process", codegenHarness: "opencode" }
      },
      repo: {
        upsertAgentTaskQueued,
        auditTool: vi.fn(async () => undefined)
      },
      agentRuntime,
      agentRuntimeSession: {
        sessionId: "agent-session-channel",
        traceId: "prompt-message-1",
        threadKey: "discord:g:c",
        guildId: "g",
        channelId: "c",
        userId: "u",
        title: "Channel session",
        request: "how should we track events?",
        requestedBy: "User",
        status: "running",
        harness: "in-process",
        model: null,
        provider: null,
        codexThreadId: null,
        metadata: {},
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date()
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({ request: "add a calendar integration", title: "Add calendar support" })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1",
      agentRuntimeExecutionId: "agent-execution-prompt",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how should we track events?");
    const taskId = enqueueAgentTask.mock.calls[0]?.[0].taskId;

    expect(taskId).toEqual(expect.stringMatching(/^task-/));
    expect(response.content).toContain(`Task ID: \`${taskId}\``);
    expect(agentRuntime.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-channel",
        role: "tool",
        parts: [expect.objectContaining({ toolName: "runCodingAgent", taskId })]
      })
    );
    expect(agentRuntime.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-channel",
        taskId,
        harness: "runCodingAgent"
      })
    );
    expect(upsertAgentTaskQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        taskType: "code_update",
        title: "Add calendar support",
        request: "add a calendar integration",
        parentAgentSessionId: "agent-session-channel",
        parentAgentExecutionId: "agent-execution-prompt",
        parentAgentThreadKey: "discord:g:c"
      })
    );
    expect(upsertAgentTaskQueued.mock.invocationCallOrder[0]).toBeLessThan(
      agentRuntime.createExecution.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        runtimeMirror: "external",
        traceId: "prompt-message-1",
        parentAgentSessionId: "agent-session-channel",
        parentAgentExecutionId: "agent-execution-prompt",
        parentAgentThreadKey: "discord:g:c",
        title: "Add calendar support",
        request: "add a calendar integration",
        discordResponseChannelId: "c",
        discordResponseMessageId: "reply-1"
      })
    );
  });

  it("continues after linked Discord evidence when a code-update request still needs a PR tool", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-exclude-channel"
    }));
    const auditTool = vi.fn(async () => undefined);
    const messageContext = vi.fn(async () => [
      agentSearchResult({
        messageId: "333333333333333333",
        channelId: "trivia",
        normalizedContent: "The trivia-sucks channel should not be part of the bot knowledge base.",
        link: "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, github: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        messageContext,
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-context",
                name: "getDiscordMessageContext",
                argumentsText: JSON.stringify({
                  messageIdOrUrl: "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
                })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-codegen",
                name: "runCodingAgent",
                argumentsText: JSON.stringify({
                  request:
                    "Fully remove the trivia-sucks channel from current and future Discord knowledge, including storage, indexing, embeddings, retrieval, stats, summaries, and attachment search.",
                  title: "Exclude trivia-sucks from knowledge"
                })
              }
            ]
          })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c", "trivia"],
      threadKey: "discord:g:c",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    const response = await handleAgentRequest(
      ctx,
      "open pr to fully remove trivia-sucks from your current and future knowledge https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
    );

    expect(response.content).toContain("Task ID: `task-exclude-channel`");
    expect(messageContext).toHaveBeenCalledWith(expect.objectContaining({ messageId: "333333333333333333" }));
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Exclude trivia-sucks from knowledge",
        request: expect.stringContaining("Fully remove the trivia-sucks channel"),
        taskType: "code_update"
      })
    );
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordMessageContext" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "runCodingAgent" }));
  });

  it("uses the lazily-created Discord status message when enqueueing codegen jobs", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-lazy-status"
    }));
    const ctx = {
      config: { maxReplyChars: 1800, github: {} },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({ request: "add better task progress updates", title: "Improve task progress updates" })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      statusChannelId: undefined,
      statusMessageId: undefined,
      updateStatus: vi.fn(async () => {
        ctx.statusChannelId = "c";
        ctx.statusMessageId = "lazy-reply-1";
      })
    } as unknown as ToolContext & { statusChannelId?: string; statusMessageId?: string };

    const response = await handleAgentRequest(ctx, "update yourself to show better task progress");

    expect(response.content).toContain("Task ID: `task-lazy-status`");
    expect(ctx.updateStatus).toHaveBeenCalledWith("Working on it...\n\nI’ll edit this message with progress and the PR link when it’s ready.");
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Improve task progress updates",
        request: "add better task progress updates",
        discordResponseChannelId: "c",
        discordResponseMessageId: "lazy-reply-1"
      })
    );
  });

  it("preserves prompt trace and Discord scope when warm runtimes enqueue codegen without a status updater", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-warm-runtime"
    }));
    const ctx = {
      config: { maxReplyChars: 1800, github: {} },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({ request: "make warm runtime task updates reliable", title: "Fix warm task updates" })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "update yourself so warm runtime task updates work");

    expect(response.content).toContain("Task ID: `task-warm-runtime`");
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "prompt-message-1",
        guildId: "g",
        channelId: "c",
        userId: "u",
        title: "Fix warm task updates",
        request: "make warm runtime task updates reliable",
        discordResponseChannelId: "c",
        discordResponseMessageId: undefined
      })
    );
  });

  it("audits failed agent requests before surfacing the error to Discord", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: { auditTool },
      openRouter: {
        chat: vi.fn(async () => {
          throw new Error("model unavailable");
        })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    await expect(handleAgentRequest(ctx, "tell me a story")).rejects.toThrow("model unavailable");
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "agentError",
        argumentsSummary: "tell me a story",
        error: "model unavailable"
      })
    );
  });
});

function channelTopicCandidate(content: string, embedding: number[]) {
  return {
    channelId: "stonks",
    channelName: "stonks",
    messageId: `m-${content}`,
    authorUsername: "alice",
    normalizedContent: content,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    embedding,
    channelMessageCount: 1000
  };
}

function agentSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "m1",
    guildId: "g",
    channelId: "c",
    authorId: "alice",
    authorUsername: "alice",
    content: "I have a job interview tomorrow",
    normalizedContent: "I have a job interview tomorrow",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    score: 1,
    link: "https://discord.com/channels/g/c/m1",
    ...overrides
  };
}
