import { describe, expect, it } from "vitest";
import {
  openRouterServerToolRegistry,
  renderToolList,
  TOOL_GROUPS,
  toolContracts,
  toolDefinitionsForModel,
  toolRegistry,
  toolSupportsCsvFormat
} from "../../src/tools/registry.js";

describe("toolRegistry", () => {
  it("contains the local milestone tools", () => {
    expect(toolRegistry.map((tool) => tool.name)).toEqual([
      "listTools",
      "requestAdditionalTools",
      "findDiscordUsers",
      "findDiscordChannels",
      "searchDiscordHistory",
      "getRecentAgentMemory",
      "getAgentMemoryStats",
      "getRecentDiscordMessages",
      "getDiscordMessageContext",
      "listDiscordBugMarkers",
      "searchDiscordAttachments",
      "inspectDiscordFile",
      "inspectDiscordImages",
      "getDiscordUserAvatar",
      "getDiscordStats",
      "getDiscordChannelTopics",
      "summarizeDiscordHistory",
      "summarizeDiscordThread",
      "generateImage",
      "readGeneratedFile",
      "queryGeneratedCsv",
      "queryGeneratedTable",
      "createSkillDraft",
      "runCodingAgent",
      "getAgentTaskStatus",
      "listAgentTasks",
      "retryAgentTask",
      "cancelAgentTask",
      "getDeploymentStatus",
      "getSpendSummary",
      "undoConversationTurns",
      "inspectAgentLogs",
      "reportStatus",
      "getWalletBalance",
      "listWalletBalances",
      "transferWalletFunds",
      "requestStarterFunds",
      "adminTransferWalletFunds",
      "reconcileWalletTransfers",
      "getSpotifyPlaylistTracks",
      "getSpotifyAlbumTracks",
      "getSpotifyArtistDiscography",
      "getSpotifyPlaylistStats",
      "compareSpotifyPlaylists",
      "searchSpotify",
      "getSpotifyItem",
      "createDiscordPoll",
      "updateBotAvatar",
      "setUserTurnLimit",
      "drawRandom",
      "awaitRandomWagerAction",
      "settleRandomWager",
      "revealRandomness"
    ]);
  });

  it("renders a user-visible tool list", () => {
    expect(renderToolList()).toContain("searchDiscordHistory");
    expect(renderToolList()).not.toContain("requestAdditionalTools");
    expect(renderToolList()).toContain("inspectDiscordImages");
    expect(renderToolList()).toContain("inspectDiscordFile");
    expect(renderToolList()).toContain("Generate an image");
    expect(renderToolList()).toContain("web_search");
  });

  it("routes wallet balances through verified onchain USD", () => {
    const tool = toolRegistry.find((entry) => entry.name === "getWalletBalance");

    expect(tool?.description).toContain("ALWAYS call this");
    expect(tool?.description).toContain("USDC.e");
    expect(tool?.description).not.toContain("PathUSD");
    expect(tool?.outputContract).toContain("verified current USD balance");
    expect(toolRegistry.find((entry) => entry.name === "listWalletBalances")?.outputContract)
      .toContain("only verified non-$0 rows for balance views");
    expect(toolRegistry.find((entry) => entry.name === "listWalletBalances")?.parameters.properties)
      .toHaveProperty("view");
  });

  it("scopes wager continuation tools without exposing opaque wager ids to the model", () => {
    for (const name of ["awaitRandomWagerAction", "settleRandomWager"] as const) {
      const tool = toolRegistry.find((entry) => entry.name === name);
      expect(tool?.parameters.properties).not.toHaveProperty("wagerId");
      expect(tool?.parameters.required ?? []).not.toContain("wagerId");
    }
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
        }),
        expect.objectContaining({
          name: "inspectDiscordFile",
          category: "discord",
          toolClass: "retrieval",
          outputContract: expect.arrayContaining([
            "bounded extracted content labeled as untrusted data",
            "explicit parser limitations or safe failure reason"
          ]),
          permissionRequirements: ["requester_visible_discord_channels"],
          auditEvents: expect.arrayContaining(["discord.file.fetched", "discord.file.inspected"])
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

  it("enumerates valid tool escalation groups in the model schema", () => {
    const definition = toolDefinitionsForModel().find(
      (tool) => "function" in tool && tool.function.name === "requestAdditionalTools"
    );
    if (!definition || !("function" in definition)) throw new Error("requestAdditionalTools definition not found");
    const properties = definition.function.parameters.properties as Record<
      string,
      { items?: { enum?: string[] } }
    >;

    expect(properties.groups.items?.enum).toEqual(TOOL_GROUPS);
  });

  it("tells the model to preserve code-update action intent", () => {
    const definition = toolDefinitionsForModel().find((tool) => "function" in tool && tool.function.name === "runCodingAgent");
    if (!definition || !("function" in definition)) throw new Error("runCodingAgent definition not found");
    const properties = definition.function.parameters.properties as Record<string, { description?: string }>;

    expect(properties.request.description).toContain("Preserve the user's desired outcome");
    expect(properties.title.description).toContain("Name the intended change");
  });

  it("exposes bounded batch controls for Discord file inspection", () => {
    const definition = toolDefinitionsForModel().find(
      (tool) => "function" in tool && tool.function.name === "inspectDiscordFile"
    );
    if (!definition || !("function" in definition)) throw new Error("inspectDiscordFile definition not found");
    const properties = definition.function.parameters.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >;

    expect(properties.batchMode.enum).toEqual(["inspect", "list"]);
    expect(definition.function.description).toContain("exact iRacing setup values");
    expect(definition.function.description).toContain("SDK .ibt telemetry containing CarSetup data");
    expect(definition.function.description).toContain("deduplicates identical extracted content");
  });

  it("exposes reply-aware bounded model I/O controls for agent debugging", () => {
    const definition = toolDefinitionsForModel().find(
      (tool) => "function" in tool && tool.function.name === "inspectAgentLogs"
    );
    if (!definition || !("function" in definition)) throw new Error("inspectAgentLogs definition not found");
    const properties = definition.function.parameters.properties as Record<string, { enum?: string[]; description?: string }>;

    expect(properties.detail.enum).toEqual(["summary", "model_io"]);
    expect(definition.function.description).toContain("omit traceId to resolve the reply chain automatically");
    expect(definition.function.description).toContain("secret-redacted");
  });

  it("classifies local tools into the model-facing taxonomy", () => {
    const contracts = toolContracts();
    expect(new Set(contracts.map((tool) => tool.toolClass))).toEqual(
      new Set(["resolver", "retrieval", "memory", "stats", "summary", "image", "generation", "coding", "ops", "external"])
    );
    expect(contracts.find((tool) => tool.name === "findDiscordUsers")?.toolClass).toBe("resolver");
    expect(contracts.find((tool) => tool.name === "getDiscordStats")?.toolClass).toBe("stats");
    expect(contracts.find((tool) => tool.name === "readGeneratedFile")?.toolClass).toBe("retrieval");
    expect(contracts.find((tool) => tool.name === "queryGeneratedCsv")?.toolClass).toBe("stats");
    expect(contracts.find((tool) => tool.name === "queryGeneratedTable")?.toolClass).toBe("stats");
    expect(contracts.find((tool) => tool.name === "summarizeDiscordHistory")?.toolClass).toBe("summary");
    expect(contracts.find((tool) => tool.name === "inspectDiscordImages")?.toolClass).toBe("image");
    expect(contracts.find((tool) => tool.name === "getSpotifyPlaylistTracks")?.toolClass).toBe("external");
    expect(contracts.find((tool) => tool.name === "getSpotifyPlaylistTracks")?.category).toBe("external");
    expect(contracts.find((tool) => tool.name === "getSpotifyAlbumTracks")?.toolClass).toBe("external");
    expect(contracts.find((tool) => tool.name === "getSpotifyArtistDiscography")?.toolClass).toBe("external");
    expect(contracts.find((tool) => tool.name === "getSpotifyPlaylistStats")?.toolClass).toBe("external");
    expect(contracts.find((tool) => tool.name === "compareSpotifyPlaylists")?.toolClass).toBe("external");
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
                format: expect.objectContaining({
                  enum: ["text", "csv", "both"],
                  description: expect.stringContaining("Defaults to both")
                })
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
                type: expect.objectContaining({ enum: ["track", "artist", "album", "playlist", "show", "episode", "audiobook", "chapter"] })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getSpotifyAlbumTracks",
            parameters: expect.objectContaining({
              required: ["albumIdOrUrl"],
              properties: expect.objectContaining({
                format: expect.objectContaining({ enum: ["text", "csv", "both"] })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getSpotifyArtistDiscography",
            parameters: expect.objectContaining({
              required: ["artistIdOrUrl"],
              properties: expect.objectContaining({
                includeGroups: expect.objectContaining({ type: "array" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "readGeneratedFile",
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                fileName: expect.objectContaining({ type: "string" }),
                maxBytes: expect.objectContaining({ type: "number" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "queryGeneratedCsv",
            description: expect.stringContaining("generated CSV"),
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                operation: expect.objectContaining({ enum: ["profile", "topValues", "filterRows"] }),
                filters: expect.objectContaining({ type: "array" }),
                splitValues: expect.objectContaining({ type: "boolean" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "queryGeneratedTable",
            description: expect.stringContaining("generated table"),
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                operation: expect.objectContaining({ enum: ["profile", "topValues", "filterRows"] }),
                tableName: expect.objectContaining({ type: "string" }),
                filters: expect.objectContaining({ type: "array" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "compareSpotifyPlaylists",
            parameters: expect.objectContaining({
              required: ["playlistAIdOrUrl", "playlistBIdOrUrl"]
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

  it("detects local tools that expose a CSV attachment format", () => {
    expect(toolSupportsCsvFormat("getSpotifyPlaylistTracks")).toBe(true);
    expect(toolSupportsCsvFormat("getSpotifyAlbumTracks")).toBe(true);
    expect(toolSupportsCsvFormat("getSpotifyArtistDiscography")).toBe(true);
    expect(toolSupportsCsvFormat("searchSpotify")).toBe(false);
    expect(toolSupportsCsvFormat("queryGeneratedCsv")).toBe(false);
  });
});
