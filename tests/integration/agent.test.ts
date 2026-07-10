import { describe, expect, it, vi } from "vitest";
import { handleAgentRequest } from "../../src/agent/router.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("agent router", () => {
  it("stops recovery calls at the per-turn model call ceiling", async () => {
    const traceEvents: any[] = [];
    const searchCall = (round: number) => ({
      content: "",
      model: "router-model",
      raw: {},
      toolCalls: [
        { id: `call-${round}`, name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: `topic ${round}` }) }
      ]
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(searchCall(1))
      .mockResolvedValueOnce(searchCall(2))
      .mockResolvedValueOnce(searchCall(3))
      .mockResolvedValueOnce(searchCall(4))
      .mockResolvedValueOnce({
        content: "<tool_call>openrouter_web_search<arg_key>query</arg_key><arg_value>test</arg_value></tool_call>",
        model: "router-model",
        raw: {},
        toolCalls: []
      });
    const keywordSearch = vi.fn(async (input: { query: string }) => [
      agentSearchResult({
        messageId: `m-${input.query}`,
        content: `Evidence about ${input.query}`,
        normalizedContent: `Evidence about ${input.query}`
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, toolsetScoping: false, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => {
          traceEvents.push(event);
        })
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "keep going");

    expect(chat).toHaveBeenCalledTimes(5);
    expect(response.content).toContain("safety limit");
    expect(traceEvents.some((event) => event.eventName === "agent.model_call_ceiling")).toBe(true);
  });

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
      userDisplayName: "UserA",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          role: "user",
          authorId: "someone-else",
          authorDisplayName: "UserB",
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
            content: expect.stringContaining("Current Discord requester: UserA (user ID requester-id)")
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("First-person pronouns in the latest user request")
          })
        ])
      })
    );
  });

  it("preserves long final model answers so Discord delivery can split them", async () => {
    const longAnswer = "alpha ".repeat(120).trim();
    const chat = vi.fn(async () => ({
      content: longAnswer,
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 80 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "write a long response");

    expect(response.content).toBe(longAnswer);
    expect(response.content.length).toBeGreaterThan(80);
    expect(response.content).not.toContain("[truncated]");
  });

  it("encourages best-effort answers for harmless subjective requests", async () => {
    const chat = vi.fn(async () => ({
      content: "I will take a swing.",
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
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "rank the funniest bits in here");

    const messages = ((chat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as { messages?: { role: string; content: string }[] })
      ?.messages ?? [];
    const systemPrompt = messages.find((message) => message.role === "system" && message.content.includes("Default to helping"))?.content ?? "";
    expect(systemPrompt).toContain("do not refuse just because the answer is subjective");
    expect(systemPrompt).toContain("Do not moralize or refuse merely because a request is edgy");
    expect(systemPrompt).toContain("give a best-effort answer");
    expect(systemPrompt).toContain("Reserve refusals for true safety boundaries");
  });

  it("prioritizes reply-chain context over unrelated channel memory for vague follow-ups", async () => {
    const chat = vi.fn(async () => ({
      content: "That was about the birthday bit, not the match.",
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
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          id: 1,
          threadKey: "discord:g:c",
          discordMessageId: "sports-1",
          role: "assistant",
          authorId: "bot",
          authorDisplayName: "ai",
          content: "England beat Mexico today, so they did not both pass.",
          parts: [],
          metadata: {},
          createdAt: new Date("2026-07-06T20:54:00.000Z")
        }
      ],
      replyContext: {
        messageId: "parent-1",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "ai",
        authorIsBot: true,
        content: "Happy birthday to you and Alabamananadar if it really is July 6th.",
        attachmentSummaries: [],
        createdAt: "2026-07-06T20:55:48.000Z",
        url: "https://discord.com/channels/g/c/parent-1",
        rootMessageId: "root-1",
        chain: [
          {
            messageId: "root-1",
            channelId: "c",
            guildId: "g",
            authorId: "human",
            authorDisplayName: "UserB",
            authorIsBot: false,
            content: "this occurred on mine and banandadars birthday, coincidence?",
            attachmentSummaries: [],
            createdAt: "2026-07-06T20:55:10.000Z",
            url: "https://discord.com/channels/g/c/root-1"
          },
          {
            messageId: "parent-1",
            channelId: "c",
            guildId: "g",
            authorId: "bot",
            authorDisplayName: "ai",
            authorIsBot: true,
            content: "Happy birthday to you and Alabamananadar if it really is July 6th.",
            attachmentSummaries: [],
            createdAt: "2026-07-06T20:55:48.000Z",
            url: "https://discord.com/channels/g/c/parent-1"
          }
        ]
      }
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "how is that today? they both passed");

    const messages = (chat as unknown as { mock: { calls: Array<[{ messages: { role: string; content: string }[] }]> } }).mock.calls[0]?.[0]
      ?.messages ?? [];
    const mainSystemPrompt = messages.find((message) => message.role === "system" && message.content.includes("For Discord replies"))?.content ?? "";
    const replyPrompt = messages.find((message) => message.role === "system" && message.content.includes("The current user message is a Discord reply"))?.content ?? "";
    expect(mainSystemPrompt).toContain("treat the reply-chain context as primary");
    expect(mainSystemPrompt).toContain("Do not infer birthdays");
    expect(replyPrompt).toContain("primary context");
    expect(replyPrompt).toContain("Do not switch to unrelated channel memory");
  });

  it("injects a prominent self-referential identity instruction for the current requester", async () => {
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
      userId: "luke-id",
      userDisplayName: "UserB",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "who am I");

    const calls = (chat as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const messages = (calls[0]?.[0] as { messages?: { role: string; content: string }[] })?.messages ?? [];
    const requesterIndex = messages.findIndex(
      (m) => m.role === "system" && m.content.includes("Current Discord requester: UserB (user ID luke-id)")
    );
    expect(requesterIndex).toBeGreaterThanOrEqual(0);

    const requesterMessage = messages[requesterIndex];
    expect(requesterMessage.content).toContain("who am I");
    expect(requesterMessage.content).toContain("Do not use skill content");
    expect(requesterMessage.content).toContain("name: UserB");

    const skillIndex = messages.findIndex(
      (m) => m.role === "system" && m.content.startsWith("Loaded skills:")
    );
    expect(skillIndex).toBeGreaterThanOrEqual(0);
    expect(requesterIndex).toBeLessThan(skillIndex);
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

  it("presents sandbox-first GitHub CI debugging guidance to the model", async () => {
    const chat = vi.fn(async () => ({
      content: "I should hand this to the sandbox.",
      model: "router-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        github: { repository: "example/discord-ai-agent", token: "test-token" },
        execution: { taskSigningSecret: "test-secret" }
      },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      replyContext: {
        rootMessageId: "root",
        messageId: "bot-reply",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "Discord AI Agent",
        authorIsBot: true,
        content: "Done: https://github.com/example/discord-ai-agent/pull/111\nRun console: https://tasks.example/runs/task-1",
        attachmentSummaries: [],
        attachments: [],
        createdAt: "2026-07-04T00:10:00.000Z",
        url: "https://discord.com/channels/g/c/bot-reply",
        chain: []
      }
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "there's a CI error");

    const firstCall = (chat as any).mock.calls[0]?.[0];
    expect(firstCall).toBeTruthy();
    expect(firstCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("For GitHub, PR, CI, check, test, deployment, repository, or self-update debugging/fixing, call runCodingAgent")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Done: https://github.com/example/discord-ai-agent/pull/111")
        })
      ])
    );
    expect(firstCall.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "runCodingAgent",
            description: expect.stringContaining("gh CLI access")
          })
        })
      ])
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

  it("continues to synthesis after Spotify tools while redacting stored transcript content", async () => {
    const appendMessage = vi.fn(async () => undefined);
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        estimatedCostUsd: 0.001,
        toolCalls: [
          {
            id: "call-spotify",
            name: "getSpotifyPlaylistTracks",
            argumentsText: JSON.stringify({
              playlistIdOrUrl: "https://open.spotify.com/playlist/pl123",
              limit: 5
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "I could not read that Spotify playlist because Spotify is not configured.",
        model: "router-model",
        raw: {},
        estimatedCostUsd: 0.001,
        toolCalls: []
      });
    const ctx = {
      config: { maxReplyChars: 1800, spotify: {} },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      agentRuntime: { appendMessage },
      agentRuntimeSession: { sessionId: "agent-session-spotify" },
      agentRuntimeExecutionId: "agent-execution-spotify",
      openRouter: { chat },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      requestId: "prompt-message-spotify"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "list tracks in https://open.spotify.com/playlist/pl123");

    expect(response.content).toContain("Spotify is not configured");
    expect(response.storedContent).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-spotify",
        role: "tool",
        parts: [
          expect.objectContaining({
            type: "tool_result",
            toolCallId: "call-spotify",
            toolName: "getSpotifyPlaylistTracks",
            content: expect.stringContaining("Spotify response omitted")
          })
        ],
        metadata: expect.objectContaining({
          toolName: "getSpotifyPlaylistTracks",
          responseRedacted: true
        })
      })
    );
    expect(JSON.stringify(appendMessage.mock.calls)).not.toContain("Spotify is not configured");
    expect(chat.mock.calls[1]?.[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-spotify",
          name: "getSpotifyPlaylistTracks",
          content: expect.stringContaining("Spotify is not configured")
        })
      ])
    );
  });

  it("lets the model query CSV files produced by earlier tool calls", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [
          {
            id: "call-export",
            name: "getSpotifyPlaylistTracks",
            argumentsText: JSON.stringify({
              playlistIdOrUrl: "https://open.spotify.com/playlist/pl123",
              format: "csv",
              limit: 4
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
            id: "call-query",
            name: "queryGeneratedCsv",
            argumentsText: JSON.stringify({
              fileName: "spotify-playlist-my-cool-playlist.csv",
              operation: "topValues",
              column: "artists",
              filters: [{ column: "added_at", op: "gte", value: "2025-07-05" }],
              splitValues: true,
              limit: 2
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "Radiohead wins the recent-adds list with 2 tracks.",
        model: "chat-model",
        raw: {},
        toolCalls: []
      });
    const ctx = {
      config: { maxReplyChars: 1800, spotify: { clientId: "id", clientSecret: "secret" } },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
        if (href.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
          return jsonResponse({
            id: "pl123",
            name: "My Cool Playlist",
            owner: { display_name: "Owner One" },
            tracks: { total: 4 },
            external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
          });
        }
        if (href.includes("/playlists/pl123/items?")) {
          return jsonResponse({
            total: 4,
            next: null,
            items: [
              playlistEntry(0, "Old Song", "Old Artist", "2024-01-01"),
              playlistEntry(1, "New A", "Radiohead, Thom Yorke", "2025-08-01"),
              playlistEntry(2, "New B", "Radiohead", "2025-09-01"),
              playlistEntry(3, "New C", "Kate Bush", "2025-10-01")
            ]
          });
        }
        throw new Error(`unexpected URL ${href}`);
      })
    );

    try {
      const response = await handleAgentRequest(ctx, "top artists added in the last year for this Spotify playlist");

      expect(response.content).toContain("Radiohead wins");
      expect(response.files?.[0].name).toBe("spotify-playlist-my-cool-playlist.csv");
      expect(chat).toHaveBeenCalledTimes(3);
      expect(chat.mock.calls[2]?.[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-query",
            name: "queryGeneratedCsv",
            content: expect.stringContaining("1. Radiohead (2)")
          })
        ])
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coerces same-round generated CSV producers to CSV when the model also queries the CSV", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [
          {
            id: "call-export",
            name: "getSpotifyPlaylistTracks",
            argumentsText: JSON.stringify({
              playlistIdOrUrl: "https://open.spotify.com/playlist/pl123",
              limit: 4
            })
          },
          {
            id: "call-query",
            name: "queryGeneratedCsv",
            argumentsText: JSON.stringify({
              operation: "topValues",
              column: "artists",
              filters: [{ column: "added_at", op: "gte", value: "2025-07-05" }],
              splitValues: true,
              limit: 2
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "Radiohead wins the recent-adds list with 2 tracks.",
        model: "chat-model",
        raw: {},
        toolCalls: []
      });
    const ctx = {
      config: { maxReplyChars: 1800, spotify: { clientId: "id", clientSecret: "secret" } },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
        if (href.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
          return jsonResponse({
            id: "pl123",
            name: "My Cool Playlist",
            owner: { display_name: "Owner One" },
            tracks: { total: 4 },
            external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
          });
        }
        if (href.includes("/playlists/pl123/items?")) {
          return jsonResponse({
            total: 4,
            next: null,
            items: [
              playlistEntry(0, "Old Song", "Old Artist", "2024-01-01"),
              playlistEntry(1, "New A", "Radiohead, Thom Yorke", "2025-08-01"),
              playlistEntry(2, "New B", "Radiohead", "2025-09-01"),
              playlistEntry(3, "New C", "Kate Bush", "2025-10-01")
            ]
          });
        }
        throw new Error(`unexpected URL ${href}`);
      })
    );

    try {
      const response = await handleAgentRequest(ctx, "top artists added in the last year for this Spotify playlist");

      expect(response.content).toContain("Radiohead wins");
      expect(response.files?.map((file) => file.name)).toEqual(["spotify-playlist-my-cool-playlist.csv"]);
      expect(chat).toHaveBeenCalledTimes(2);
      expect(chat.mock.calls[1]?.[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                id: "call-export",
                function: expect.objectContaining({
                  name: "getSpotifyPlaylistTracks",
                  arguments: expect.stringContaining('"format":"csv"')
                })
              })
            ])
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-query",
            name: "queryGeneratedCsv",
            content: expect.stringContaining("1. Radiohead (2)")
          })
        ])
      );
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("lets the model count completed agent turns since an anchor phrase", async () => {
    const agentMemoryTurnStats = vi.fn(async () => ({
      anchor: {
        messageId: "anchor-1",
        guildId: "g",
        channelId: "c",
        authorId: "u",
        authorUsername: "connor",
        authorDisplayName: "Alex",
        content: "where she’s staying for the time being",
        normalizedContent: "where she’s staying for the time being",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        link: "https://discord.com/channels/g/c/anchor-1"
      },
      completedTurnCount: 3,
      recentAssistantTurns: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        agentMemoryTurnStats,
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
                name: "getAgentMemoryStats",
                argumentsText: JSON.stringify({
                  sinceText: "where she's staying for the time being",
                  sinceAuthor: "requester"
                })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "3 turns.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "Alex",
      visibleChannelIds: ["c"],
      requestId: "current-message"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how many turns have you completed since I said where she's staying?");

    expect(response.content).toBe("3 turns.");
    expect(agentMemoryTurnStats).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        channelId: "c",
        threadKey: "discord:g:c",
        anchorText: "where she's staying for the time being",
        anchorAuthorId: "u",
        excludeMessageId: "current-message"
      })
    );
    expect((ctx.openRouter.chat as any).mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", name: "getAgentMemoryStats", content: expect.stringContaining("Completed assistant turns") })])
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
    const keywordSearch = vi
      .fn()
      .mockResolvedValueOnce([agentSearchResult()])
      .mockResolvedValueOnce([
        agentSearchResult({
          messageId: "m2",
          normalizedContent: "The interview went great",
          content: "The interview went great",
          link: "https://discord.com/channels/g/c/m2"
        })
      ]);
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

  it("nudges the model to answer when a rephrased search returns the same evidence", async () => {
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
            toolCalls: [{ id: "call-2", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job hunt" }) }]
          })
          .mockResolvedValueOnce({
            content: "Alice mentioned a job interview coming up.",
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

    const response = await handleAgentRequest(ctx, "what have people said about job hunting?");

    expect(response.content).toBe("Alice mentioned a job interview coming up.");
    expect(keywordSearch).toHaveBeenCalledTimes(2);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
    const finalMessages = JSON.stringify((ctx.openRouter.chat as any).mock.calls[2][0].messages);
    expect(finalMessages).toContain("Effective query: job hunting");
    expect(finalMessages).toContain("returned the same evidence as an earlier searchDiscordHistory call");
  });

  it("forces final synthesis after a second same-evidence search", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [agentSearchResult()]);
    const searchCall = (round: number, query: string) => ({
      content: "",
      model: `router-model-${round}`,
      raw: {},
      toolCalls: [{ id: `call-${round}`, name: "searchDiscordHistory", argumentsText: JSON.stringify({ query }) }]
    });
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
          .mockResolvedValueOnce(searchCall(1, "job hunting"))
          .mockResolvedValueOnce(searchCall(2, "job hunt"))
          .mockResolvedValueOnce(searchCall(3, "hunting for jobs"))
          .mockResolvedValueOnce({
            content: "Alice has a job interview tomorrow; that is the only job talk.",
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

    const response = await handleAgentRequest(ctx, "what have people said about job hunting?");

    expect(response.content).toBe("Alice has a job interview tomorrow; that is the only job talk.");
    expect(keywordSearch).toHaveBeenCalledTimes(3);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(4);
    const repeatGuardAudits = (auditTool.mock.calls as any[]).filter(
      (call) => call[0]?.toolName === "agentToolRepeatGuard"
    );
    expect(repeatGuardAudits).toHaveLength(2);
    expect((ctx.openRouter.chat as any).mock.calls[3][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining("Write one natural Discord reply") })
      ])
    );
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
    // Forced final synthesis is deliberately tool-free so models cannot leak tool-call markup.
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toBeUndefined();
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
            globalName: "UserA",
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
    let recentCall = 0;
    const recentMessagesFromChannels = vi.fn(async () => {
      recentCall += 1;
      return [
        agentSearchResult({
          messageId: `m-${recentCall}`,
          content: `Update number ${recentCall} about jobs`,
          normalizedContent: `Update number ${recentCall} about jobs`
        })
      ];
    });
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
    // Forced final synthesis is deliberately tool-free so models cannot leak tool-call markup.
    expect((ctx.openRouter.chat as any).mock.calls[4][0].tools).toBeUndefined();
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
    // Forced final synthesis is deliberately tool-free so models cannot leak tool-call markup.
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toBeUndefined();
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

  it("recovers when leaked tool markup uses a mutated tool name", async () => {
    // Regression for a prod incident: the model leaked
    // "<tool_call>openserver_web_search</tool_call>" (note: not openrouter_),
    // which the old name-based guard let straight through to Discord.
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
            content: "<tool_call>openserver_web_search</tool_call>",
            model: "tool-leak-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "Nobody in this server was drafted, sorry.",
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

    const response = await handleAgentRequest(ctx, "who got drafted?");

    expect(response.content).toBe("Nobody in this server was drafted, sorry.");
    expect(response.content).not.toContain("tool_call");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("recovers when a hosted OpenRouter tool call leaks as a partial closing fragment", async () => {
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
            content: "openrouter_web_search</tool_call>",
            model: "tool-leak-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "A flyover happened before the match.",
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

    const response = await handleAgentRequest(ctx, "what flew over the game?");

    expect(response.content).toBe("A flyover happened before the match.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect((ctx.openRouter.chat as any).mock.calls[1][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("preserves reply context and fresh tool evidence when recovering leaked hosted tool markup", async () => {
    const auditTool = vi.fn(async () => undefined);
    const storeProcessRunArtifact = vi.fn(async () => ({ artifactId: "artifact-leaked-hosted-tool" }));
    const leakedHostedToolMarkup =
      "<tool_call>openrouter_web_fetch<arg_key>url</arg_key><arg_value>https://github.com/example/discord-ai-agent/pull/111</arg_value></tool_call>";
    const task = {
      taskId: "task-1",
      traceId: "trace-1",
      guildId: "g",
      channelId: "c",
      userId: "u",
      threadKey: "discord:g:c",
      discordResponseChannelId: "c",
      discordResponseMessageId: "bot-reply",
      retriedFromTaskId: null,
      taskType: "code_update",
      title: "Fix CI task",
      request: "fix the failing test",
      requestedBy: "User",
      status: "succeeded",
      backend: "kubernetes",
      currentStep: "done",
      statusMessage: "Opened pull request.",
      branchName: "ai/fix-ci-task",
      prUrl: "https://github.com/example/discord-ai-agent/pull/111",
      draft: false,
      verifyPassed: null,
      error: null,
      createdAt: new Date("2026-07-04T00:00:00.000Z"),
      startedAt: new Date("2026-07-04T00:00:01.000Z"),
      cancelledAt: null,
      completedAt: new Date("2026-07-04T00:10:00.000Z"),
      notifiedAt: null,
      notificationError: null,
      progressUpdatedAt: new Date("2026-07-04T00:10:00.000Z"),
      lastRenderedSignature: null,
      lastRenderedAt: null,
      terminalRenderedAt: null,
      updatedAt: new Date("2026-07-04T00:10:00.000Z")
    };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{ id: "call-1", name: "getAgentTaskStatus", argumentsText: JSON.stringify({ taskId: "task-1" }) }]
      })
      .mockResolvedValueOnce({
        content: leakedHostedToolMarkup,
        model: "tool-leak-model",
        raw: {},
        toolCalls: []
      })
      .mockImplementationOnce(async (input: { messages: Array<{ role: string; content: string; name?: string }> }) => {
        const recoveryContext = JSON.stringify(input.messages);
        expect(recoveryContext).toContain("The current user message is a Discord reply");
        expect(recoveryContext).toContain("Fresh local tool result from getAgentTaskStatus");
        expect(recoveryContext).toContain("PR: https://github.com/example/discord-ai-agent/pull/111");
        expect(recoveryContext).toContain("Using the conversation, reply context, and fresh local tool results above");
        expect(recoveryContext).toContain("openrouter:web_fetch");
        expect(recoveryContext).toContain("https://github.com/example/discord-ai-agent/pull/111");
        expect(recoveryContext).toContain("call the matching hosted tool through the provided tool channel now");
        return {
          content: "PR #111 is the relevant PR; check its CI details there.",
          model: "recovery-model",
          raw: {},
          toolCalls: []
        };
      });
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        getAgentTask: vi.fn(async () => task),
        getTaskProgressEventsForTask: vi.fn(async () => []),
        getSandboxCommandEvents: vi.fn(async () => []),
        storeProcessRunArtifact,
        auditTool
      },
      openRouter: { chat },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      requestId: "prompt-message-1",
      visibleChannelIds: ["c"],
      replyContext: {
        rootMessageId: "root",
        messageId: "parent",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "Discord AI Agent",
        authorIsBot: true,
        content: "Done: https://github.com/example/discord-ai-agent/pull/111",
        attachmentSummaries: [],
        attachments: [],
        createdAt: "2026-07-04T00:10:00.000Z",
        url: "https://discord.com/channels/g/c/parent",
        chain: [
          {
            messageId: "parent",
            channelId: "c",
            guildId: "g",
            authorId: "bot",
            authorDisplayName: "Discord AI Agent",
            authorIsBot: true,
            content: "Done: https://github.com/example/discord-ai-agent/pull/111",
            attachmentSummaries: [],
            attachments: [],
            createdAt: "2026-07-04T00:10:00.000Z",
            url: "https://discord.com/channels/g/c/parent"
          }
        ]
      }
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "there's a CI error");

    expect(response.content).toBe("PR #111 is the relevant PR; check its CI details there.");
    expect(chat).toHaveBeenCalledTimes(3);
    expect(storeProcessRunArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "prompt-message-1",
        kind: "model_transcript",
        name: "Malformed hosted tool output round 2",
        content: leakedHostedToolMarkup,
        metadata: expect.objectContaining({
          model: "tool-leak-model",
          round: 2,
          reason: "hosted_tool_markup_leaked",
          intendedHostedTools: [
            {
              type: "openrouter:web_fetch",
              arguments: { url: "https://github.com/example/discord-ai-agent/pull/111" }
            }
          ]
        })
      })
    );
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
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
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
      ...fakeAgentRuntimeContext(),
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

    expect(response.content).toMatch(
      /^Working on it\.\.\.\n\nI’ll update this message with progress and the PR link when it’s ready\.\nTask ID: `task-[^`]+`\.$/
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
        github: { repository: "example/discord-ai-agent", token: "test-token" },
        openRouter: { codegenModel: "z-ai/glm-5.2" },
        execution: { codegenBackend: "local-process", codegenHarness: "opencode", taskSigningSecret: "test-secret" }
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
        harnessThreadId: null,
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

  it("passes model-selected existing PR targets into code-update jobs", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-existing-pr"
    }));
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
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
              argumentsText: JSON.stringify({
                request: "Fix the failing CI check on PR #120 and push to the existing branch.",
                title: "Fix CI on PR #120",
                targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
                targetPullRequestNumber: 120,
                targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
              })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "fix CI in that PR");

    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "Fix the failing CI check on PR #120 and push to the existing branch.",
        title: "Fix CI on PR #120",
        targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
        targetPullRequestNumber: 120,
        targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
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
        normalizedContent: "The example-channel channel should not be part of the bot knowledge base.",
        link: "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
      })
    ]);
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        messageContext,
        upsertAgentTaskQueued: vi.fn(async () => undefined),
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
                    "Fully remove the example-channel channel from current and future Discord knowledge, including storage, indexing, embeddings, retrieval, stats, summaries, and attachment search.",
                  title: "Exclude example-channel from knowledge"
                })
              }
            ]
          })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
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
      "open pr to fully remove example-channel from your current and future knowledge https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
    );

    expect(response.content).toMatch(/Task ID: `task-[^`]+`/);
    expect(messageContext).toHaveBeenCalledWith(expect.objectContaining({ messageId: "333333333333333333" }));
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Exclude example-channel from knowledge",
        request: expect.stringContaining("Fully remove the example-channel channel"),
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
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
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
      ...fakeAgentRuntimeContext(),
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

    expect(response.content).toMatch(/Task ID: `task-[^`]+`/);
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
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
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
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "update yourself so warm runtime task updates work");

    expect(response.content).toMatch(/Task ID: `task-[^`]+`/);
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

function fakeAgentRuntimeContext() {
  return {
    agentRuntime: {
      appendMessage: vi.fn(async () => undefined),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => undefined)
    },
    agentRuntimeSession: {
      sessionId: "agent-session-channel",
      traceId: "prompt-message-1",
      threadKey: "discord:g:c",
      guildId: "g",
      channelId: "c",
      userId: "u",
      title: "Channel session",
      request: "test request",
      requestedBy: "User",
      status: "running",
      harness: "in-process",
      model: null,
      provider: null,
      harnessThreadId: null,
      metadata: {},
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date()
    },
    agentRuntimeExecutionId: "agent-execution-prompt",
    requestId: "prompt-message-1"
  };
}

function codeUpdateTestConfig() {
  return {
    maxReplyChars: 1800,
    github: { repository: "example/discord-ai-agent", token: "test-token" },
    openRouter: { codegenModel: "z-ai/glm-5.2" },
    execution: { codegenBackend: "local-process", codegenHarness: "opencode", taskSigningSecret: "test-secret" }
  };
}

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function playlistEntry(index: number, name: string, artists: string, addedAt: string) {
  return {
    added_at: `${addedAt}T00:00:00Z`,
    is_local: false,
    item: {
      id: `track-${index}`,
      name,
      type: "track",
      duration_ms: 180000,
      explicit: false,
      artists: artists.split(",").map((artist) => ({ name: artist.trim() })),
      album: { name: `Album ${index}` },
      external_urls: { spotify: `https://open.spotify.com/track/track-${index}` }
    }
  };
}
