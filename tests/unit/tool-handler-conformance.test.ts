import { describe, expect, it } from "vitest";
import { delegatedToolNames } from "../../src/agent/toolDispatcher.js";
import { handlerDefinitions, handlerFamilies } from "../../src/agent/toolHandlers/index.js";
import { toolRegistry, type ToolName } from "../../src/tools/registry.js";
import { bindToolHandlers } from "../../src/tools/toolDefinition.js";

const expectedFamilyTools = {
  core: ["listTools"],
  discordRetrieval: [
    "findDiscordUsers", "findDiscordChannels", "listDiscordBugMarkers", "inspectDiscordFile",
    "summarizeDiscordThread", "getRecentDiscordMessages", "getRecentAgentMemory", "getAgentMemoryStats",
    "getDiscordMessageContext", "searchDiscordAttachments", "getDiscordStats", "getDiscordChannelTopics",
    "summarizeDiscordHistory", "searchDiscordHistory",
  ],
  ops: [
    "reportStatus", "setUserTurnLimit", "inspectAgentLogs", "createSkillDraft", "manageSkills",
    "getDeploymentStatus", "getSpendSummary",
  ],
  discordAction: ["undoConversationTurns", "drawRandom", "revealRandomness", "settleRandomWager"],
  codegen: ["runCodingAgent", "getAgentTaskStatus", "listAgentTasks", "retryAgentTask", "cancelAgentTask"],
  image: ["generateImage", "inspectDiscordImages", "getDiscordUserAvatar"],
  generatedData: ["readGeneratedFile", "queryGeneratedCsv", "queryGeneratedTable"],
  spotify: [
    "getSpotifyPlaylistTracks", "getSpotifyAlbumTracks", "getSpotifyArtistDiscography",
    "getSpotifyPlaylistStats", "compareSpotifyPlaylists", "searchSpotify", "getSpotifyItem",
  ],
} satisfies Record<keyof typeof handlerFamilies, ToolName[]>;

describe("tool handler conformance", () => {
  it.each(Object.entries(expectedFamilyTools))("binds every %s adapter exactly once", (family, expectedNames) => {
    const handlers = handlerFamilies[family as keyof typeof handlerFamilies];
    expect(Object.keys(handlers)).toEqual(expectedNames);
    for (const name of expectedNames) expect(handlers[name as keyof typeof handlers]).toBeTypeOf("function");
  });

  it("covers every contract with one focused handler or delegated router", () => {
    const handled = Object.values(handlerFamilies).flatMap((family) => Object.keys(family));
    const routed = [...handled, ...delegatedToolNames];

    expect(new Set(routed).size).toBe(routed.length);
    expect(new Set(routed)).toEqual(new Set(toolRegistry.map((tool) => tool.name)));
    expect(() => bindToolHandlers(toolRegistry, handlerDefinitions, delegatedToolNames)).not.toThrow();
  });

  it("fails fast when an adapter is missing or unknown", () => {
    const missingHandler: Partial<typeof handlerDefinitions> = { ...handlerDefinitions };
    delete missingHandler.listTools;
    const unknownHandler = { ...handlerDefinitions, unknownTool: handlerDefinitions.listTools };
    expect(() => bindToolHandlers(toolRegistry, missingHandler, delegatedToolNames)).toThrow(/missing: listTools/);
    expect(() => bindToolHandlers(toolRegistry, unknownHandler, delegatedToolNames))
      .toThrow(/unknown: unknownTool/);
  });
});
