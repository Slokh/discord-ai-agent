import { describe, expect, it } from "vitest";
import { installedToolHandlers } from "../../src/capabilities/catalog.js";
import { coreToolHandlers } from "../../src/tools/handlers/core.js";
import { discordRetrievalToolHandlers } from "../../src/tools/handlers/discord-retrieval.js";
import { opsToolHandlers } from "../../src/tools/handlers/ops.js";
import { discordActionToolHandlers } from "../../src/tools/handlers/discord-action.js";
import { codegenToolHandlers } from "../../src/tools/handlers/codegen.js";
import { imageToolHandlers } from "../../src/tools/handlers/image.js";
import { generatedDataToolHandlers } from "../../src/tools/handlers/generated-data.js";
import { spotifyToolHandlers } from "../../src/tools/handlers/spotify.js";
import { walletToolHandlers } from "../../src/tools/handlers/wallet.js";
import { externalResearchToolHandlers } from "../../src/tools/handlers/external-research.js";
import { toolRegistry, type ToolName } from "../../src/tools/registry.js";
import { bindToolHandlers } from "../../src/tools/toolDefinition.js";

const handlerFamilies = {
  core: coreToolHandlers,
  discordRetrieval: discordRetrievalToolHandlers,
  ops: opsToolHandlers,
  discordAction: discordActionToolHandlers,
  codegen: codegenToolHandlers,
  image: imageToolHandlers,
  generatedData: generatedDataToolHandlers,
  spotify: spotifyToolHandlers,
  wallet: walletToolHandlers,
  externalResearch: externalResearchToolHandlers,
} as const;

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
  externalResearch: ["researchWeb"],
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
    expect(() => bindToolHandlers(toolRegistry, installedToolHandlers)).not.toThrow();
  });

  it("fails fast when an adapter is missing or unknown", () => {
    const missingHandler = { ...installedToolHandlers };
    delete missingHandler.loadSkillContext;
    const unknownHandler = { ...installedToolHandlers, unknownTool: installedToolHandlers.loadSkillContext };
    expect(() => bindToolHandlers(toolRegistry, missingHandler)).toThrow(/missing: loadSkillContext/);
    expect(() => bindToolHandlers(toolRegistry, unknownHandler))
      .toThrow(/unknown: unknownTool/);
  });
});
