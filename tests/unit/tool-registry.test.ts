import { describe, expect, it } from "vitest";
import { openRouterServerToolRegistry, renderToolList, toolContracts, toolDefinitionsForModel, toolRegistry } from "../../src/tools/registry.js";

describe("toolRegistry", () => {
  it("contains the local milestone tools", () => {
    expect(toolRegistry.map((tool) => tool.name)).toEqual([
      "listTools",
      "findDiscordUsers",
      "findDiscordChannels",
      "searchDiscordHistory",
      "getRecentAgentMemory",
      "getRecentDiscordMessages",
      "getDiscordMessageContext",
      "searchDiscordAttachments",
      "inspectDiscordImages",
      "getDiscordStats",
      "getDiscordChannelTopics",
      "summarizeDiscordHistory",
      "summarizeDiscordThread",
      "generateImage",
      "createSkillDraft",
      "runCodingAgent",
      "getAgentTaskStatus",
      "listAgentTasks",
      "retryAgentTask",
      "cancelAgentTask",
      "getDeploymentStatus",
      "undoConversationTurns",
      "inspectAgentLogs",
      "reportStatus",
      "getSpotifyPlaylistTracks",
      "searchSpotify",
      "getSpotifyItem"
    ]);
  });

  it("renders a user-visible tool list", () => {
    expect(renderToolList()).toContain("searchDiscordHistory");
    expect(renderToolList()).toContain("inspectDiscordImages");
    expect(renderToolList()).toContain("Generate an image");
    expect(renderToolList()).toContain("web_search");
  });

  it("exports a self-documenting contract for every local tool", () => {
    const contracts = toolContracts();
    expect(contracts.map((tool) => tool.name)).toEqual(toolRegistry.map((tool) => tool.name));
    expect(contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runCodingAgent",
          category: "coding",
          toolClass: "coding",
          mutates: true,
          outputContract: expect.arrayContaining(["PR link or failure reason"]),
          permissionRequirements: expect.arrayContaining(["explicit_user_request"]),
          auditEvents: expect.arrayContaining(["tool_audit_logs", "trace_events"]),
          examples: expect.arrayContaining(["@ai debug the failing CI on that PR"])
        }),
        expect.objectContaining({
          name: "searchDiscordHistory",
          category: "discord",
          toolClass: "retrieval",
          outputContract: expect.arrayContaining(["ranked evidence snippets", "Discord message links when available"]),
          permissionRequirements: expect.arrayContaining(["requester_visible_discord_channels"]),
          examples: expect.arrayContaining(["@ai what did we say about job hunting?"])
        })
      ])
    );
    expect(
      contracts.every(
        (tool) =>
          tool.examples.length > 0 && tool.permissionRequirements.length > 0 && tool.auditEvents.length > 0 && tool.outputContract.length > 0
      )
    ).toBe(true);
  });

  it("classifies local tools into the model-facing taxonomy", () => {
    const contracts = toolContracts();
    expect(new Set(contracts.map((tool) => tool.toolClass))).toEqual(
      new Set(["resolver", "retrieval", "memory", "stats", "summary", "image", "generation", "coding", "ops", "external"])
    );
    expect(contracts.find((tool) => tool.name === "findDiscordUsers")?.toolClass).toBe("resolver");
    expect(contracts.find((tool) => tool.name === "getDiscordStats")?.toolClass).toBe("stats");
    expect(contracts.find((tool) => tool.name === "summarizeDiscordHistory")?.toolClass).toBe("summary");
    expect(contracts.find((tool) => tool.name === "inspectDiscordImages")?.toolClass).toBe("image");
    expect(contracts.find((tool) => tool.name === "getSpotifyPlaylistTracks")?.toolClass).toBe("external");
    expect(contracts.find((tool) => tool.name === "getSpotifyPlaylistTracks")?.category).toBe("external");
    expect(contracts.find((tool) => tool.name === "searchSpotify")?.toolClass).toBe("external");
    expect(contracts.find((tool) => tool.name === "getSpotifyItem")?.toolClass).toBe("external");
  });

  it("exports OpenRouter-compatible local function and server tool definitions", () => {
    expect(toolDefinitionsForModel()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "searchDiscordHistory",
            description: expect.stringContaining("Tool class: retrieval."),
            parameters: expect.objectContaining({
              type: "object",
              required: ["query"],
              properties: expect.objectContaining({
                authorIds: expect.objectContaining({ type: "array" }),
                authorQueries: expect.objectContaining({ type: "array" }),
                aboutUserIds: expect.objectContaining({ type: "array" }),
                aboutUserQueries: expect.objectContaining({ type: "array" }),
                channelIds: expect.objectContaining({ type: "array" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "openrouter:web_search"
        }),
        expect.objectContaining({
          type: "openrouter:datetime"
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getDiscordStats",
            description: expect.stringContaining("Tool class: stats."),
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                groupBy: expect.objectContaining({ enum: expect.arrayContaining(["channel", "thread", "message", "month", "hourOfDay"]) }),
                metric: expect.objectContaining({ enum: expect.arrayContaining(["messages", "attachments", "reactions", "messagesPerChannelDay"]) }),
                sort: expect.objectContaining({ enum: expect.arrayContaining(["countDesc", "countAsc"]) })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getDiscordChannelTopics",
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                channelLimit: expect.objectContaining({ type: "number" }),
                topicsPerChannel: expect.objectContaining({ type: "number" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "summarizeDiscordHistory",
            description: expect.stringContaining("Returns: question or focus; sample window; grounded summary; coverage limits."),
            parameters: expect.objectContaining({
              required: ["question"],
              properties: expect.objectContaining({
                authorIds: expect.objectContaining({ type: "array" }),
                aboutUserIds: expect.objectContaining({ type: "array" }),
                aboutUserQueries: expect.objectContaining({ type: "array" }),
                sampleLimit: expect.objectContaining({ type: "number" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "runCodingAgent",
            description: expect.stringContaining("debug or fix failing CI/checks/tests")
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getSpotifyPlaylistTracks",
            description: expect.stringContaining("Do not use web_fetch on open.spotify.com"),
            parameters: expect.objectContaining({
              required: ["playlistIdOrUrl"],
              properties: expect.objectContaining({
                format: expect.objectContaining({ enum: ["text", "csv"] })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getSpotifyItem",
            parameters: expect.objectContaining({
              required: ["itemIdOrUrl"],
              properties: expect.objectContaining({
                type: expect.objectContaining({ enum: ["track", "artist", "album", "playlist"] })
              })
            })
          })
        })
      ])
    );
  });

  it("enables the initial hosted OpenRouter tools", () => {
    expect(openRouterServerToolRegistry.map((tool) => tool.type)).toEqual([
      "openrouter:web_search",
      "openrouter:web_fetch",
      "openrouter:datetime"
    ]);
    expect(openRouterServerToolRegistry.every((tool) => tool.toolClass === "external" && tool.outputContract.length > 0)).toBe(true);
  });
});
