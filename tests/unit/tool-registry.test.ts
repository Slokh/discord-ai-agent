import { describe, expect, it } from "vitest";
import {
  openRouterServerToolRegistry,
  localToolDefinitionsForModel,
  toolDefinitionsForModel,
  toolRegistry
} from "../../src/tools/registry.js";
import { TOOL_NAMES } from "../../src/tools/toolDefinition.js";

describe("toolRegistry", () => {
  it("contains the local milestone tools", () => {
    expect(toolRegistry.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it("reuses compiled model definitions for the stable deployment toolset", () => {
    expect(toolDefinitionsForModel()).toBe(toolDefinitionsForModel());
  });

  it("keeps the complete local model tool contract below its prompt-cost budget", () => {
    expect(Buffer.byteLength(JSON.stringify(localToolDefinitionsForModel()), "utf8")).toBeLessThan(82_000);
  });

  it("keeps operational reads behind the strict operator policy", () => {
    for (const name of ["reportStatus", "getDeploymentStatus", "getSpendSummary"] as const) {
      expect(toolRegistry.find((tool) => tool.name === name)?.accessPolicy).toBe("strict_ops");
    }
    expect(toolRegistry.some((tool) => String(tool.name) === "inspectAgentLogs")).toBe(false);
  });

  it("derives the rich presentation tool contract from the exhaustive runtime schema", () => {
    const tool = toolRegistry.find((entry) => entry.name === "composeDiscordResponse");
    const schema = JSON.stringify(tool?.parameters);

    expect(schema).toContain('"media_gallery"');
    expect(schema).toContain('"mentionable_select"');
    expect(schema).toContain('"file_upload"');
    expect(schema).toContain('"radio_group"');
    expect(schema).toContain('"checkbox_group"');
    expect(schema).not.toContain('"additionalProperties":true');
    expect(Buffer.byteLength(schema, "utf8")).toBeLessThan(30_000);
    expect(tool?.argumentExamples[0]).toEqual(expect.objectContaining({
      components: expect.any(Array),
    }));
    const definition = localToolDefinitionsForModel([tool!])[0];
    expect(definition?.function.description).not.toContain("Example arguments:");
    expect(definition?.function.description).not.toContain('"type":"action_row"');
    expect(definition?.function.parameters).toBe(tool?.parameters);
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
    expect(toolRegistry.find((entry) => entry.name === "getWagerHistory")?.description)
      .toContain("canonical real-USD wager ledger");
  });

  it("requires authoritative Discord stats for supported count capability questions", () => {
    const tool = toolRegistry.find((entry) => entry.name === "getDiscordStats");
    const properties = tool?.parameters.properties as Record<string, unknown> | undefined;

    expect(tool?.description).toContain("ALWAYS call this");
    expect(tool?.description).toContain("capability question");
    expect(tool?.description).toContain("preferring words when words are named");
    expect(tool?.description).toContain("instead of claiming those totals are unavailable");
    expect(tool?.description).toContain("exact `Metric: <label>` line verbatim");
    expect(properties?.metric).toEqual(expect.objectContaining({
      enum: expect.arrayContaining(["messages", "characters", "words"]),
    }));
  });

  it("requires current group-level evidence for demographic health comparisons", () => {
    const tool = toolRegistry.find((entry) => entry.name === "web__run");

    expect(tool?.description).toContain("ALWAYS call this");
    expect(tool?.description).toContain("demographic comparisons involving health outcomes or life expectancy");
    expect(tool?.description).toContain("exact phrase `group-level`");
    expect(tool?.description).toContain("from an individual prediction");
    expect(tool?.description).toContain("without substituting unsolicited personal or relationship advice");
  });

  it("exposes explicit image alpha controls and transparent emoji validation", () => {
    const imageProperties = toolRegistry.find((entry) => entry.name === "generateImage")?.parameters.properties;
    const emojiProperties = toolRegistry.find((entry) => entry.name === "createDiscordEmoji")?.parameters.properties;

    expect(imageProperties).toHaveProperty("background");
    expect(imageProperties).toHaveProperty("outputFormat");
    expect(imageProperties).toHaveProperty("aspectRatio");
    expect(imageProperties).toHaveProperty("requiredText");
    expect(emojiProperties).toHaveProperty("requireTransparent");
    expect(toolRegistry.find((entry) => entry.name === "generateImage")?.description)
      .toContain("Do not call it for diagnosis-only questions");
  });

  it("scopes wager continuation tools without exposing opaque wager ids to the model", () => {
    for (const name of ["awaitRandomWagerAction", "settleRandomWager"] as const) {
      const tool = toolRegistry.find((entry) => entry.name === name);
      expect(tool?.parameters.properties).not.toHaveProperty("wagerId");
      expect(tool?.parameters.required ?? []).not.toContain("wagerId");
    }
  });

  it("keeps a self-documenting contract for every local tool", () => {
    const contracts = toolRegistry;
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
          auditEvents: expect.arrayContaining(["tool_audit_logs", "agent_runtime_events"]),
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

  it("tells the model to preserve code-update action intent", () => {
    const definition = toolDefinitionsForModel().find((tool) => "function" in tool && tool.function.name === "runCodingAgent");
    if (!definition || !("function" in definition)) throw new Error("runCodingAgent definition not found");
    const properties = definition.function.parameters.properties as Record<string, { description?: string }>;

    expect(properties.request.description).toContain("Preserve the user's desired outcome");
    expect(properties.title.description).toContain("Name the intended change");
    expect(definition.function.description).toContain("Generic requests about my reports");
    const improvementInbox = toolDefinitionsForModel().find((tool) => "function" in tool && tool.function.name === "listMyImprovementSignals");
    if (!improvementInbox || !("function" in improvementInbox)) throw new Error("listMyImprovementSignals definition not found");
    expect(improvementInbox.function.description).toContain("requester's active improvement reports");
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

  it("classifies local tools into the model-facing taxonomy", () => {
    const contracts = toolRegistry;
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

  it("assigns internal latency budgets without exposing them to the model", () => {
    expect(toolRegistry.every((tool) => Number.isFinite(tool.latencyBudgetMs) && tool.latencyBudgetMs > 0)).toBe(true);
    expect(toolRegistry.find((tool) => tool.name === "getRecentDiscordMessages")?.latencyBudgetMs).toBe(15_000);
    expect(toolRegistry.find((tool) => tool.name === "getDiscordStats")?.latencyBudgetMs).toBe(20_000);
    expect(toolRegistry.find((tool) => tool.name === "inspectDiscordImages")?.latencyBudgetMs).toBe(60_000);
    expect(toolRegistry.find((tool) => tool.name === "generateImage")?.latencyBudgetMs).toBe(120_000);
    expect(JSON.stringify(localToolDefinitionsForModel())).not.toContain("latencyBudgetMs");
  });

  it("exports OpenRouter-compatible local function and server tool definitions", () => {
    expect(toolDefinitionsForModel()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "searchDiscordHistory",
            description: expect.not.stringContaining("Tool class:"),
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
          type: "function",
          function: expect.objectContaining({
            name: "getDiscordStats",
            description: expect.stringContaining("observed message timing only"),
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
            description: expect.not.stringContaining("Returns: question or focus; sample window; grounded summary; coverage limits."),
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
            description: expect.stringContaining("failing CI, checks, or tests")
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

  it("keeps the stable complete model contract compact", () => {
    const definitions = toolDefinitionsForModel();
    const totalBytes = Buffer.byteLength(JSON.stringify(definitions));
    const presentation = definitions.find((tool) => "function" in tool && tool.function.name === "composeDiscordResponse");
    expect(totalBytes).toBeLessThan(82_000);
    expect(Buffer.byteLength(JSON.stringify(presentation))).toBeLessThan(5_500);
  });

  it("enables the initial hosted OpenRouter tools", () => {
    expect(openRouterServerToolRegistry.map((tool) => tool.type)).toEqual([
      "openrouter:web_search",
      "openrouter:web_fetch"
    ]);
    expect(openRouterServerToolRegistry.every((tool) => tool.toolClass === "external" && tool.outputContract.length > 0)).toBe(true);
  });

  it("detects local tools that expose a CSV attachment format", () => {
    const supportsCsv = (name: string) => {
      const properties = toolRegistry.find((tool) => tool.name === name)?.parameters.properties as Record<string, unknown> | undefined;
      const format = properties?.format as { enum?: unknown[] } | undefined;
      return Array.isArray(format?.enum) && format.enum.includes("csv");
    };
    expect(supportsCsv("getSpotifyPlaylistTracks")).toBe(true);
    expect(supportsCsv("getSpotifyAlbumTracks")).toBe(true);
    expect(supportsCsv("getSpotifyArtistDiscography")).toBe(true);
    expect(supportsCsv("searchSpotify")).toBe(false);
    expect(supportsCsv("queryGeneratedCsv")).toBe(false);
  });
});
