import type { FunctionToolDefinition } from "../models/openrouter.js";

export const TOOL_NAMES = [
  "listTools", "requestAdditionalTools", "composeDiscordResponse", "findDiscordUsers", "findDiscordChannels",
  "searchDiscordHistory", "getRecentAgentMemory", "getAgentMemoryStats", "getRecentDiscordMessages", "getDiscordMessageContext",
  "listDiscordBugMarkers", "searchDiscordAttachments", "inspectDiscordFile", "inspectDiscordImages", "getDiscordUserAvatar",
  "getDiscordStats", "getDiscordChannelTopics", "summarizeDiscordHistory", "summarizeDiscordThread", "generateImage",
  "readGeneratedFile", "queryGeneratedCsv", "queryGeneratedTable", "createSkillDraft", "manageSkills", "runCodingAgent",
  "getAgentTaskStatus", "listAgentTasks", "retryAgentTask", "cancelAgentTask", "getDeploymentStatus", "getSpendSummary",
  "undoConversationTurns", "inspectAgentLogs", "reportStatus", "getWalletBalance", "listWalletBalances", "getWagerHistory",
  "transferWalletFunds", "requestStarterFunds", "adminTransferWalletFunds", "reconcileWalletTransfers", "getSpotifyPlaylistTracks",
  "getSpotifyAlbumTracks", "getSpotifyArtistDiscography", "getSpotifyPlaylistStats", "compareSpotifyPlaylists", "searchSpotify",
  "getSpotifyItem", "createDiscordPoll", "createDiscordEmoji", "updateBotAvatar", "setUserTurnLimit", "drawRandom",
  "awaitRandomWagerAction", "settleRandomWager", "revealRandomness",
] as const;
export type ToolName = typeof TOOL_NAMES[number];

export type ToolGroup = "core" | "discord-retrieval" | "generated-data" | "presentation" | "discord-action" | "image" | "spotify" | "codegen" | "ops" | "external";
export const TOOL_GROUPS: ToolGroup[] = ["core", "discord-retrieval", "generated-data", "presentation", "discord-action", "image", "spotify", "codegen", "ops", "external"];

export type ToolClass = "resolver" | "retrieval" | "memory" | "stats" | "summary" | "image" | "generation" | "coding" | "ops" | "external";

export type ToolRegistryEntry = {
  name: ToolName;
  description: string;
  userVisible: boolean;
  mutates: boolean;
  category?: "discord" | "generation" | "memory" | "ops" | "coding" | "external";
  group: ToolGroup;
  toolClass?: ToolClass;
  outputContract?: string[];
  examples?: string[];
  permissionRequirements?: string[];
  auditEvents?: string[];
  parameters: FunctionToolDefinition["function"]["parameters"];
};

export type ToolContract = {
  name: ToolName;
  description: string;
  category: NonNullable<ToolRegistryEntry["category"]>;
  toolClass: ToolClass;
  mutates: boolean;
  userVisible: boolean;
  parameters: FunctionToolDefinition["function"]["parameters"];
  whenToUse: string;
  outputContract: string[];
  permissionRequirements: string[];
  auditEvents: string[];
  examples: string[];
};

/** Identity helper that preserves literal names while checking every contract at compile time. */
export function defineTool<const T extends ToolRegistryEntry>(definition: T): T {
  return definition;
}

/** Binds contracts to execution handlers once at startup and fails fast on drift. */
export function bindToolHandlers<H>(
  contracts: readonly ToolRegistryEntry[],
  handlers: Partial<Record<ToolName, H>>,
  delegated: readonly ToolName[] = [],
): Readonly<Partial<Record<ToolName, H>>> {
  const contractNames = new Set(contracts.map((contract) => contract.name));
  const delegatedNames = new Set(delegated);
  const missing = [...contractNames].filter((name) => handlers[name] === undefined && !delegatedNames.has(name));
  const unknown = Object.keys(handlers).filter((name) => !contractNames.has(name as ToolName));
  if (missing.length || unknown.length) {
    throw new Error(`Tool execution registry mismatch (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`);
  }
  return Object.freeze({ ...handlers });
}
