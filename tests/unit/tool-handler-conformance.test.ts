import { describe, expect, it } from "vitest";
import { handlerDefinitions, handlerFamilies } from "../../src/agent/toolHandlers/index.js";
import { toolRegistry, type ToolName } from "../../src/tools/registry.js";
import { bindToolHandlers } from "../../src/tools/toolDefinition.js";

const expectedFamilyTools = {
  core: ["loadSkillContext"],
  discordRetrieval: [
    "findDiscordUsers", "findDiscordChannels", "listDiscordBugMarkers", "inspectDiscordFile",
    "summarizeDiscordThread", "getRecentDiscordMessages", "getRecentAgentMemory", "getAgentMemoryStats",
    "getDiscordMessageContext", "searchDiscordAttachments", "getDiscordStats", "getDiscordChannelTopics",
    "summarizeDiscordHistory", "searchDiscordHistory",
  ],
  ops: [
    "reportStatus", "setAgentModel", "inspectAgentLogs",
    "getDeploymentStatus", "getSpendSummary",
  ],
  discordAction: [
    "composeDiscordResponse", "addDiscordReaction", "createDiscordPoll", "updateBotAvatar", "createDiscordEmoji",
    "undoConversationTurns", "drawRandom", "revealRandomness", "settleRandomWager",
  ],
  codegen: ["runCodingAgent", "getAgentTaskStatus", "listAgentTasks", "retryAgentTask", "cancelAgentTask"],
  image: ["generateImage", "inspectDiscordImages", "getDiscordUserAvatar"],
  generatedData: ["readGeneratedFile", "queryGeneratedCsv", "queryGeneratedTable"],
  spotify: [
    "getSpotifyPlaylistTracks", "getSpotifyAlbumTracks", "getSpotifyArtistDiscography",
    "getSpotifyPlaylistStats", "compareSpotifyPlaylists", "searchSpotify", "getSpotifyItem",
  ],
  wallet: [
    "awaitRandomWagerAction", "getWalletBalance", "listWalletBalances", "getWagerHistory",
    "transferWalletFunds", "requestStarterFunds", "adminTransferWalletFunds",
    "adminSetWalletStarterAmount", "getWalletFeeSummary", "reconcileWalletTransfers",
  ],
} satisfies Record<keyof typeof handlerFamilies, ToolName[]>;

describe("tool handler conformance", () => {
  it.each(Object.entries(expectedFamilyTools))("binds every %s adapter exactly once", (family, expectedNames) => {
    const handlers = handlerFamilies[family as keyof typeof handlerFamilies];
    expect(Object.keys(handlers)).toEqual(expectedNames);
    for (const name of expectedNames) expect(handlers[name as keyof typeof handlers]).toBeTypeOf("function");
  });

  it("covers every contract with one focused handler", () => {
    const handled = Object.values(handlerFamilies).flatMap((family) => Object.keys(family));
    expect(new Set(handled).size).toBe(handled.length);
    expect(new Set(handled)).toEqual(new Set(toolRegistry.map((tool) => tool.name)));
    expect(() => bindToolHandlers(toolRegistry, handlerDefinitions)).not.toThrow();
  });

  it("fails fast when an adapter is missing or unknown", () => {
    const missingHandler: Partial<typeof handlerDefinitions> = { ...handlerDefinitions };
    delete missingHandler.loadSkillContext;
    const unknownHandler = { ...handlerDefinitions, unknownTool: handlerDefinitions.loadSkillContext };
    expect(() => bindToolHandlers(toolRegistry, missingHandler)).toThrow(/missing: loadSkillContext/);
    expect(() => bindToolHandlers(toolRegistry, unknownHandler))
      .toThrow(/unknown: unknownTool/);
  });
});
