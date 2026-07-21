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
  "getSpotifyItem", "addDiscordReaction", "createDiscordPoll", "createDiscordEmoji", "updateBotAvatar", "setUserTurnLimit", "drawRandom",
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
  category: "discord" | "generation" | "memory" | "ops" | "coding" | "external";
  group: ToolGroup;
  toolClass: ToolClass;
  outputContract: string[];
  examples: string[];
  permissionRequirements: string[];
  auditEvents: string[];
  argumentExamples: Record<string, unknown>[];
  parameters: FunctionToolDefinition["function"]["parameters"];
};

type ToolDefinitionInput = Omit<ToolRegistryEntry, "outputContract" | "permissionRequirements" | "auditEvents" | "argumentExamples"> &
  Partial<Pick<ToolRegistryEntry, "outputContract" | "permissionRequirements" | "auditEvents" | "argumentExamples">>;

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
  argumentExamples: Record<string, unknown>[];
};

const outputContractByToolClass: Record<ToolClass, string[]> = {
  resolver: ["resolved IDs", "display names", "match confidence or ambiguity notes", "result count"],
  retrieval: ["applied filters", "ranked evidence snippets", "match sources when available", "Discord message links when available", "result count"],
  memory: ["memory scope", "durable action or retrieved turns", "audit trail"],
  stats: ["metric", "grouping", "filters", "ranked rows", "result count"],
  summary: ["question or focus", "sample window", "grounded summary", "coverage limits"],
  image: ["image URLs or attachment IDs", "visual observations", "uncertainty when the image is unclear"],
  generation: ["generation prompt", "reference image count", "attached output file or URL"],
  coding: ["task ID and status", "run-console link when available", "PR link or failure reason", "progress summary"],
  ops: ["requested diagnostic", "current status", "recent failures or next action"],
  external: ["external request", "returned source data", "source URLs when available"]
};

/** Materializes one complete contract from explicit taxonomy plus generic policy defaults. */
export function defineTool<const T extends ToolDefinitionInput>(definition: T): T & ToolRegistryEntry {
  return {
    ...definition,
    outputContract: definition.outputContract ?? outputContractByToolClass[definition.toolClass],
    permissionRequirements: definition.permissionRequirements ?? (
      definition.mutates
        ? ["explicit_user_request", "tool_audit_log"]
        : definition.category === "discord"
          ? ["requester_visible_discord_channels", "tool_audit_log"]
          : ["tool_audit_log"]
    ),
    auditEvents: definition.auditEvents ?? ["tool_audit_logs", "trace_events"],
    argumentExamples: definition.argumentExamples ?? [],
  };
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
