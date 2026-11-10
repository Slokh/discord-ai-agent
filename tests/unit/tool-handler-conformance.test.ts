import { describe, expect, it } from "vitest";
import { installedToolHandlers } from "../../src/capabilities/catalog.js";
import { coreToolHandlers } from "../../src/tools/handlers/core.js";
import { userSettingsToolHandlers } from "../../src/tools/handlers/user-settings.js";
import { discordRetrievalToolHandlers } from "../../src/tools/handlers/discord-retrieval.js";
import { discordActionToolHandlers } from "../../src/tools/handlers/discord-action.js";
import { imageToolHandlers } from "../../src/tools/handlers/image.js";
import { generatedDataToolHandlers } from "../../src/tools/handlers/generated-data.js";
import { walletToolHandlers } from "../../src/tools/handlers/wallet.js";
import { externalResearchToolHandlers } from "../../src/tools/handlers/external-research.js";
import { toolRegistry, type ToolName } from "../../src/tools/registry.js";
import { bindToolHandlers } from "../../src/tools/toolDefinition.js";

const handlerFamilies = {
  core: coreToolHandlers,
  userSettings: userSettingsToolHandlers,
  discordRetrieval: discordRetrievalToolHandlers,
  discordAction: discordActionToolHandlers,
  image: imageToolHandlers,
  generatedData: generatedDataToolHandlers,
  wallet: walletToolHandlers,
  externalResearch: externalResearchToolHandlers,
} as const;

const expectedFamilyTools = {
  core: ["loadSkillContext"],
  userSettings: ["setMyTimezone"],
  discordRetrieval: [
    "findDiscordUsers", "findDiscordChannels", "inspectDiscordFile",
    "summarizeDiscordThread", "getRecentDiscordMessages", "getRecentAgentMemory", "getAgentMemoryStats",
    "getDiscordMessageContext", "searchDiscordAttachments", "getDiscordStats", "getDiscordChannelTopics",
    "summarizeDiscordHistory", "searchDiscordHistory",
  ],
  discordAction: [
    "addDiscordReaction", "createDiscordPoll", "drawRandom", "revealRandomness", "settleRandomWager",
  ],
  image: ["generateImage", "inspectDiscordImages", "getDiscordUserAvatar"],
  generatedData: ["readGeneratedFile", "queryGeneratedCsv", "queryGeneratedTable"],
  wallet: [
    "awaitRandomWagerAction", "getWalletBalance", "listWalletBalances", "getWagerHistory",
    "transferWalletFunds", "requestStarterFunds", "getWalletFeeSummary",
  ],
  externalResearch: ["web__run"],
} satisfies Record<keyof typeof handlerFamilies, ToolName[]>;

describe("tool handler conformance", () => {
  it.each(Object.entries(expectedFamilyTools))("binds every %s adapter exactly once", (family, expectedNames) => {
    const handlers = handlerFamilies[family as keyof typeof handlerFamilies];
    expect(Object.keys(handlers)).toEqual(expectedNames);
    for (const name of expectedNames) expect(handlers[name as keyof typeof handlers]).toBeTypeOf("function");
  });

  it("covers every contract with one focused handler", () => {
    const handled = Object.keys(installedToolHandlers);
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
